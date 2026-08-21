use std::{
    collections::HashMap,
    io::{Error as IoError, ErrorKind, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    process::{Command as StdCommand, Stdio},
    str,
    sync::{
        atomic::{AtomicU32, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
#[cfg(target_os = "macos")]
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::Emitter;
use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

#[derive(Default)]
struct ServerState(Mutex<ServerStatus>);

struct ServerRuntime {
    url: String,
    child: CommandChild,
}

#[derive(Default)]
struct ServerStatus {
    runtime: Option<ServerRuntime>,
    startup_error: Option<String>,
}

/// 与 ServerState 平级的 adapter 子进程状态。
///
/// adapter sidecar（superai-agent-sidecar adapters --feishu --telegram）的生命周期
/// 跟 server 不同：它没有 HTTP 端口可探活，没配凭据时会自己干净退出，
/// 而且需要支持运行时热重启 —— 用户在设置页保存飞书 / Telegram 凭据后，
/// 前端会通过 invoke('restart_adapters_sidecar') 来重启它，让新凭据生效。
#[derive(Default)]
struct AdapterState(Mutex<Option<CommandChild>>);

#[derive(Default)]
struct TerminalState {
    next_id: AtomicU32,
    sessions: Mutex<HashMap<u32, TerminalSession>>,
}

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

#[derive(Serialize, Clone)]
struct TerminalSpawnResult {
    session_id: u32,
    shell: String,
    cwd: String,
}

#[derive(Serialize, Clone)]
struct TerminalOutputPayload {
    session_id: u32,
    data: String,
}

#[derive(Serialize, Clone)]
struct TerminalExitPayload {
    session_id: u32,
    code: u32,
    signal: Option<String>,
}

#[tauri::command]
fn get_server_url(state: State<'_, ServerState>) -> Result<String, String> {
    let guard = state
        .0
        .lock()
        .map_err(|_| "desktop server state is unavailable".to_string())?;

    if let Some(runtime) = guard.runtime.as_ref() {
        return Ok(runtime.url.clone());
    }

    Err(guard
        .startup_error
        .clone()
        .unwrap_or_else(|| "desktop server did not start".to_string()))
}

/// 前端在设置页保存飞书 / Telegram 凭据后调用，触发 adapter sidecar 热重启。
///
/// 流程：
///   1. kill 当前 adapter 子进程（如果在跑）
///   2. spawn 新的 adapter 子进程
///   3. 新 sidecar 内部的 loadConfig() 会读到最新的 ~/.claude/adapters.json
///      并重新建立 WebSocket 连接到飞书 / Telegram
///
/// 凭据缺失时 sidecar 自己会 warn + skip + 退出，所以这里不需要前置检查。
#[tauri::command]
fn restart_adapters_sidecar(app: AppHandle) -> Result<(), String> {
    stop_adapters_sidecar(&app);
    spawn_and_track_adapters_sidecar(&app);
    Ok(())
}

#[tauri::command]
fn prepare_for_update_install(app: AppHandle) -> Result<(), String> {
    stop_server_sidecar(&app);
    stop_adapters_sidecar(&app);

    #[cfg(target_os = "windows")]
    {
        kill_windows_sidecars();
    }

    // Give Windows a short moment to release executable file handles before the
    // updater starts replacing bundled sidecars in the install directory.
    std::thread::sleep(Duration::from_millis(750));
    Ok(())
}

#[tauri::command]
fn terminal_spawn(
    app: AppHandle,
    state: State<'_, TerminalState>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<TerminalSpawnResult, String> {
    let cwd_path = resolve_terminal_cwd(cwd)?;
    let shell = default_shell();
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(8),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("open terminal pty: {err}"))?;

    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(cwd_path.as_os_str());
    for (key, value) in terminal_environment(&shell) {
        cmd.env(key, value);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|err| format!("spawn terminal shell: {err}"))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|err| format!("clone terminal reader: {err}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|err| format!("open terminal writer: {err}"))?;
    let killer = child.clone_killer();
    let session_id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;

    {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "terminal state is unavailable".to_string())?;
        sessions.insert(
            session_id,
            TerminalSession {
                master: pair.master,
                writer: Mutex::new(writer),
                killer: Mutex::new(killer),
            },
        );
    }

    let output_app = app.clone();
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        let mut pending_utf8 = Vec::new();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let data = decode_terminal_output(&mut pending_utf8, &buffer[..n]);
                    if !data.is_empty() {
                        let _ = output_app.emit(
                            "terminal-output",
                            TerminalOutputPayload { session_id, data },
                        );
                    }
                }
                Err(err) => {
                    let _ = output_app.emit(
                        "terminal-output",
                        TerminalOutputPayload {
                            session_id,
                            data: format!("\r\n[terminal read error: {err}]\r\n"),
                        },
                    );
                    break;
                }
            }
        }
        if !pending_utf8.is_empty() {
            let data = String::from_utf8_lossy(&pending_utf8).to_string();
            let _ = output_app.emit(
                "terminal-output",
                TerminalOutputPayload { session_id, data },
            );
        }
    });

    let exit_app = app.clone();
    thread::spawn(move || {
        let status = child.wait();
        if let Some(state) = exit_app.try_state::<TerminalState>() {
            if let Ok(mut sessions) = state.sessions.lock() {
                sessions.remove(&session_id);
            }
        }
        match status {
            Ok(status) => {
                let _ = exit_app.emit(
                    "terminal-exit",
                    TerminalExitPayload {
                        session_id,
                        code: status.exit_code(),
                        signal: status.signal().map(ToString::to_string),
                    },
                );
            }
            Err(err) => {
                let _ = exit_app.emit(
                    "terminal-output",
                    TerminalOutputPayload {
                        session_id,
                        data: format!("\r\n[terminal wait error: {err}]\r\n"),
                    },
                );
            }
        }
    });

    Ok(TerminalSpawnResult {
        session_id,
        shell,
        cwd: cwd_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn terminal_write(
    state: State<'_, TerminalState>,
    session_id: u32,
    data: String,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "terminal state is unavailable".to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "terminal session is not running".to_string())?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| "terminal writer is unavailable".to_string())?;
    writer
        .write_all(data.as_bytes())
        .map_err(|err| format!("write terminal input: {err}"))?;
    writer
        .flush()
        .map_err(|err| format!("flush terminal input: {err}"))?;
    Ok(())
}

#[tauri::command]
fn terminal_resize(
    state: State<'_, TerminalState>,
    session_id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "terminal state is unavailable".to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "terminal session is not running".to_string())?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(8),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("resize terminal: {err}"))?;
    Ok(())
}

#[tauri::command]
fn terminal_kill(state: State<'_, TerminalState>, session_id: u32) -> Result<(), String> {
    let session = {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "terminal state is unavailable".to_string())?;
        sessions.remove(&session_id)
    };

    if let Some(session) = session {
        let mut killer = session
            .killer
            .lock()
            .map_err(|_| "terminal killer is unavailable".to_string())?;
        killer
            .kill()
            .map_err(|err| format!("kill terminal shell: {err}"))?;
    }
    Ok(())
}

fn decode_terminal_output(pending: &mut Vec<u8>, chunk: &[u8]) -> String {
    pending.extend_from_slice(chunk);
    let mut output = String::new();

    loop {
        match str::from_utf8(pending) {
            Ok(text) => {
                output.push_str(text);
                pending.clear();
                break;
            }
            Err(err) => {
                let valid_up_to = err.valid_up_to();
                if valid_up_to > 0 {
                    let text = str::from_utf8(&pending[..valid_up_to])
                        .expect("valid_up_to marks a valid UTF-8 prefix");
                    output.push_str(text);
                    pending.drain(..valid_up_to);
                    continue;
                }

                match err.error_len() {
                    Some(error_len) => {
                        output.push('\u{fffd}');
                        pending.drain(..error_len);
                    }
                    None => break,
                }
            }
        }
    }

    output
}

fn terminal_environment(shell: &str) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    env.extend(login_shell_environment(shell));
    ensure_utf8_locale(&mut env);
    env
}

fn ensure_utf8_locale(env: &mut HashMap<String, String>) {
    let fallback = default_utf8_locale();
    for key in ["LANG", "LC_CTYPE", "LC_ALL"] {
        let needs_fallback = env
            .get(key)
            .map(|value| !is_utf8_locale(value))
            .unwrap_or(true);
        if needs_fallback {
            env.insert(key.to_string(), fallback.to_string());
        }
    }
}

fn is_utf8_locale(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase().replace('-', "");
    normalized.contains("utf8")
}

fn default_utf8_locale() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "en_US.UTF-8"
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        "C.UTF-8"
    }
    #[cfg(not(unix))]
    {
        "C.UTF-8"
    }
}

#[cfg(not(target_os = "windows"))]
fn login_shell_environment(shell: &str) -> HashMap<String, String> {
    let Ok(mut child) = StdCommand::new(shell)
        .args(["-l", "-c", "env -0"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return HashMap::new();
    };

    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return HashMap::new();
                }
                let mut stdout = Vec::new();
                if let Some(mut pipe) = child.stdout.take() {
                    let _ = pipe.read_to_end(&mut stdout);
                }
                return parse_env_block(&stdout);
            }
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return HashMap::new();
            }
            Err(_) => return HashMap::new(),
        }
    }
}

#[cfg(target_os = "windows")]
fn login_shell_environment(_shell: &str) -> HashMap<String, String> {
    HashMap::new()
}

fn parse_env_block(bytes: &[u8]) -> HashMap<String, String> {
    bytes
        .split(|byte| *byte == 0)
        .filter_map(|entry| {
            if entry.is_empty() {
                return None;
            }
            let equals = entry.iter().position(|byte| *byte == b'=')?;
            if equals == 0 {
                return None;
            }
            let key = String::from_utf8_lossy(&entry[..equals]).to_string();
            let value = String::from_utf8_lossy(&entry[equals + 1..]).to_string();
            Some((key, value))
        })
        .collect()
}

fn resolve_terminal_cwd(cwd: Option<String>) -> Result<PathBuf, String> {
    let path = match cwd.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(PathBuf::from(trimmed))
        }
    }) {
        Some(path) => path,
        None => home_dir().unwrap_or(
            std::env::current_dir().map_err(|err| format!("resolve current directory: {err}"))?,
        ),
    };

    if path.is_dir() {
        Ok(path)
    } else {
        Err(format!("terminal cwd does not exist: {}", path.display()))
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn default_shell() -> String {
    #[cfg(target_os = "windows")]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| {
            if PathBuf::from("/bin/zsh").exists() {
                "/bin/zsh".to_string()
            } else {
                "/bin/bash".to_string()
            }
        })
    }
}

fn reserve_local_port() -> Result<u16, String> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|err| format!("bind local port: {err}"))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("read local port: {err}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn wait_for_server(url_host: &str, port: u16) -> Result<(), String> {
    let addr: SocketAddr = format!("{url_host}:{port}")
        .parse()
        .map_err(|err| format!("parse server address: {err}"))?;
    // Bun-compiled sidecars on Windows can need 15-25s to cold-boot the
    // first time after a build (AV scan of the 127 MB binary + JS runtime
    // init). The previous 10s budget tripped on those launches even though
    // the sidecar booted successfully a few seconds later. 30s gives AV a
    // realistic window without making genuine failures feel sluggish.
    let timeout = Duration::from_secs(30);
    let deadline = Instant::now() + timeout;

    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(150));
    }

    Err(format!(
        "desktop server did not start listening on {url_host}:{port} within {} seconds",
        timeout.as_secs()
    ))
}

/// Portable-mode bootstrap: if a `.env` file lives next to the running .exe,
/// load each `KEY=VALUE` line into the current process environment so spawned
/// sidecars inherit it. This is what lets users drop the portable folder
/// anywhere, edit `.env` in Notepad, and have the API keys take effect on the
/// next launch — no installer, no AppData spelunking.
///
/// Quietly does nothing if `.env` is absent (which is the case for the
/// installed-MSI build, where credentials live in ~/.claude/adapters.json).
fn load_portable_env_file() {
    let Ok(exe) = std::env::current_exe() else { return };
    let Some(dir) = exe.parent() else { return };
    let env_path = dir.join(".env");
    let Ok(content) = std::fs::read_to_string(&env_path) else { return };

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(eq_idx) = line.find('=') else { continue };
        let key = line[..eq_idx].trim();
        if key.is_empty() {
            continue;
        }
        let mut value = line[eq_idx + 1..].trim().to_string();
        // Strip a single layer of matching quotes — common in dotenv files.
        if value.len() >= 2 {
            let bytes = value.as_bytes();
            let first = bytes[0];
            let last = bytes[bytes.len() - 1];
            if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
                value = value[1..value.len() - 1].to_string();
            }
        }
        // Don't clobber values the user explicitly set in the parent shell.
        if std::env::var_os(key).is_none() {
            std::env::set_var(key, value);
        }
    }
    println!("[desktop] loaded portable .env from {}", env_path.display());
}

fn resolve_app_root(_app: &AppHandle) -> Result<PathBuf, String> {
    // 历史用途：此前 sidecar launcher 用 dynamic file:// import 加载磁盘上
    // 的 src/server/index.ts 和 preload.ts，所以 Tauri 必须把整个 src/ +
    // node_modules/ 当 Resource 一起 ship 到 .app/Contents/Resources/app/。
    //
    // 现在 launcher 改成静态 import + bun build --compile 整棵静态打进二进制，
    // sidecar 不再读磁盘上的 src/ 或 node_modules/。CLAUDE_APP_ROOT 现在
    // 只剩一个名义上的"app 安装根目录"作用，给 conversationService 在
    // spawn CLI 子进程时通过 --app-root 透传。
    //
    // 我们直接用当前可执行文件所在目录作为 app_root：
    //   Dev:  desktop/src-tauri/target/<profile>/  （rust 跑出来的 binary 那一层）
    //   Prod: <App>.app/Contents/MacOS/             （sidecar 二进制的同级目录）
    let exe = std::env::current_exe().map_err(|err| format!("resolve current exe path: {err}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "current exe has no parent dir".to_string())?
        .to_path_buf();
    Ok(dir)
}

/// Read HTTPS_PROXY / HTTP_PROXY / NO_PROXY from
/// `~/.claude/superai/settings.json` so they can be injected into the
/// sidecar's spawn env.
///
/// Note: an earlier version of this comment claimed Bun snapshots HTTPS_PROXY
/// at process start so the sidecar could not change it later. That is wrong,
/// and was measured to be wrong: the app builds its own fetch options per
/// request (`getProxyFetchOptions`, which reads `process.env` each call), so a
/// proxy discovered at runtime — as PAC evaluation does — takes effect
/// immediately. Injecting at spawn is still preferred because it covers the
/// child's whole lifetime including any early request.
fn read_managed_proxy_env() -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Some(home) = home_dir() else {
        return out;
    };
    let path = home.join(".claude").join("superai").join("settings.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return out;
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return out;
    };
    let Some(env) = parsed.get("env").and_then(|v| v.as_object()) else {
        return out;
    };
    for key in ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"] {
        if let Some(value) = env.get(key).and_then(|v| v.as_str()) {
            if !value.is_empty() {
                out.insert(key.to_string(), value.to_string());
            }
        }
    }

    // Defensive: when HTTPS_PROXY/HTTP_PROXY is set but NO_PROXY is not,
    // inject loopback bypass. The spawned CLI subprocess opens a WebSocket
    // back to the local server at ws://127.0.0.1:<port>. Without
    // loopback in NO_PROXY, that connection is routed through the corporate
    // proxy (which refuses CONNECT to private IPs), the SDK socket never
    // opens, and the chat hangs at "Cogitating..." indefinitely. This
    // covers existing installs whose settings.json was written before
    // ProxySettingsService.setConfig() learned to add NO_PROXY itself.
    let has_proxy = out.contains_key("HTTPS_PROXY")
        || out.contains_key("HTTP_PROXY")
        || out.contains_key("https_proxy")
        || out.contains_key("http_proxy");
    let has_no_proxy = out.contains_key("NO_PROXY") || out.contains_key("no_proxy");
    if has_proxy && !has_no_proxy {
        out.insert("NO_PROXY".to_string(), "localhost,127.0.0.1,::1".to_string());
    }

    out
}

fn map_has_proxy(env: &HashMap<String, String>) -> bool {
    ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]
        .iter()
        .any(|k| env.get(*k).is_some_and(|v| !v.is_empty()))
}

/// What the operating system itself is configured to do about proxies.
struct SystemProxy {
    enabled: bool,
    /// Raw `ProxyServer`: either `host:port` or `http=h:p;https=h:p;socks=h:p`.
    server: String,
    /// Raw `ProxyOverride`: `;`-separated, may contain the literal `<local>`.
    bypass: String,
    /// `AutoConfigURL` — a PAC script. Cannot be honored by an env var.
    pac: String,
}

/// Pick the proxy URL for HTTPS traffic out of a Windows `ProxyServer` value.
///
/// Windows stores either a single `host:port` that applies to every protocol,
/// or a per-scheme list `http=h:p;https=h:p;ftp=h:p;socks=h:p`. We want the
/// https entry, falling back to http (corporate proxies almost always use one
/// endpoint for both). socks/ftp entries are ignored: Bun's fetch proxy support
/// is HTTP CONNECT, so pointing HTTPS_PROXY at a SOCKS port would fail in a
/// far more confusing way than going direct.
fn pick_windows_proxy_url(server: &str) -> Option<String> {
    let server = server.trim();
    if server.is_empty() {
        return None;
    }

    let raw = if server.contains('=') {
        let mut http = None;
        let mut https = None;
        for part in server.split(';') {
            let Some((scheme, value)) = part.split_once('=') else {
                continue;
            };
            let value = value.trim();
            if value.is_empty() {
                continue;
            }
            match scheme.trim().to_ascii_lowercase().as_str() {
                "https" => https = Some(value),
                "http" => http = Some(value),
                _ => {}
            }
        }
        https.or(http)?
    } else {
        server
    };

    let lower = raw.to_ascii_lowercase();
    if lower.starts_with("socks") {
        return None;
    }
    // Windows omits the scheme; the proxy endpoint itself speaks HTTP CONNECT.
    if lower.starts_with("http://") || lower.starts_with("https://") {
        Some(raw.to_string())
    } else {
        Some(format!("http://{raw}"))
    }
}

/// Translate a Windows `ProxyOverride` list into a NO_PROXY value.
///
/// `<local>` is Windows shorthand for "any hostname without a dot", which is
/// not expressible in NO_PROXY; loopback is the part that actually matters to
/// us (the CLI subprocess dials back to ws://127.0.0.1). Wildcard entries are
/// normalized from Windows form `*.corp.com` to NO_PROXY form `.corp.com`.
fn windows_bypass_to_no_proxy(bypass: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut push = |entry: &str| {
        let entry = entry.trim();
        if entry.is_empty() {
            return;
        }
        let normalized = entry.strip_prefix('*').unwrap_or(entry).to_string();
        if normalized.is_empty() {
            return;
        }
        if !out
            .iter()
            .any(|e: &String| e.eq_ignore_ascii_case(&normalized))
        {
            out.push(normalized);
        }
    };

    for part in bypass.split([';', ',']) {
        if part.trim().eq_ignore_ascii_case("<local>") {
            continue;
        }
        push(part);
    }
    // Loopback is required regardless of what Windows says: the spawned CLI
    // opens a WebSocket back to the local server and must not be proxied.
    for entry in ["localhost", "127.0.0.1", "::1"] {
        push(entry);
    }

    out.join(",")
}

/// What the OS's proxy configuration amounts to, once precedence is applied.
#[derive(Debug, PartialEq, Eq)]
enum SystemProxyChoice {
    /// An auto-config script the sidecar must evaluate.
    Pac(String),
    /// A static proxy URL usable directly as HTTPS_PROXY.
    Static(String),
    Direct,
}

/// Apply Windows' actual precedence rules to a raw registry read.
///
/// The rule that matters, and that this originally got wrong: **an
/// `AutoConfigURL` wins even when `ProxyEnable` is 0**. The two values are
/// independent, not a flag gating a hierarchy - so a machine whose registry
/// reads "proxy disabled" can be fully proxied by its PAC, which is exactly
/// the configuration that could not chat while its Win10 neighbour could.
fn choose_system_proxy(system: &SystemProxy) -> SystemProxyChoice {
    let pac = system.pac.trim();
    if !pac.is_empty() {
        return SystemProxyChoice::Pac(pac.to_string());
    }
    if system.enabled {
        if let Some(url) = pick_windows_proxy_url(&system.server) {
            return SystemProxyChoice::Static(url);
        }
    }
    SystemProxyChoice::Direct
}

#[cfg(windows)]
fn read_system_proxy() -> Option<SystemProxy> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        .ok()?;

    Some(SystemProxy {
        enabled: key.get_value::<u32, _>("ProxyEnable").unwrap_or(0) != 0,
        server: key.get_value::<String, _>("ProxyServer").unwrap_or_default(),
        bypass: key
            .get_value::<String, _>("ProxyOverride")
            .unwrap_or_default(),
        pac: key
            .get_value::<String, _>("AutoConfigURL")
            .unwrap_or_default(),
    })
}

#[cfg(not(windows))]
fn read_system_proxy() -> Option<SystemProxy> {
    // macOS/Linux desktops export proxy settings into the environment for
    // GUI apps, which the sidecar inherits already. Nothing to read.
    None
}

/// Decide the proxy env the sidecars are spawned with, in priority order:
///
/// 1. `~/.claude/superai/settings.json` — the user typed it into Settings.
/// 2. The desktop's own environment — the user (or IT) exported HTTPS_PROXY;
///    the sidecar inherits it, so we must not override it.
/// 3. The **operating system's** proxy configuration.
///
/// Step 3 is the one that was missing, and it is why one corporate machine
/// works while its neighbour does not. When IT configures a system proxy,
/// every other app on the box (Edge, Office, Teams) routes through it, while
/// this app alone went direct — into whatever transparent appliance sits on
/// the path. That appliance answers with an HTML block page, which surfaces as
/// "the provider returned an empty response".
///
/// Escape hatch: `SUPERAI_USE_SYSTEM_PROXY=0` restores the old direct behavior,
/// mirroring `SUPERAI_USE_SYSTEM_CA=0`.
fn resolve_proxy_env() -> HashMap<String, String> {
    let mut out = read_managed_proxy_env();

    if map_has_proxy(&out) {
        out.insert("SUPERAI_PROXY_SOURCE".to_string(), "settings".to_string());
        return out;
    }

    let inherited = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]
        .iter()
        .any(|k| std::env::var(k).is_ok_and(|v| !v.trim().is_empty()));
    if inherited {
        println!("[desktop] proxy: source=inherited (HTTPS_PROXY set in this process's environment)");
        out.insert("SUPERAI_PROXY_SOURCE".to_string(), "inherited".to_string());
        return out;
    }

    if std::env::var("SUPERAI_USE_SYSTEM_PROXY")
        .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "0" | "false" | "no" | "off"))
        .unwrap_or(false)
    {
        println!("[desktop] proxy: source=none (system proxy disabled by SUPERAI_USE_SYSTEM_PROXY)");
        out.insert("SUPERAI_PROXY_SOURCE".to_string(), "disabled".to_string());
        return out;
    }

    let Some(system) = read_system_proxy() else {
        out.insert("SUPERAI_PROXY_SOURCE".to_string(), "none".to_string());
        return out;
    };

    // PAC FIRST. Windows honours an AutoConfigURL even when ProxyEnable is 0,
    // and prefers it over a static ProxyServer when both are set - so a machine
    // whose registry reads "no proxy" can be fully proxied. Testing `enabled`
    // first (as this did before) mis-routes exactly those machines.
    //
    // A PAC maps each URL to a proxy by running JavaScript, which no env var can
    // express, so the URL is handed to the sidecar - it has a JS engine and
    // evaluates the script for the active provider (src/utils/pac.ts).
    match choose_system_proxy(&system) {
        SystemProxyChoice::Pac(pac) => {
            println!("[desktop] proxy: source=pac {pac} (evaluated by the sidecar)");
            out.insert("SUPERAI_PAC_URL".to_string(), pac);
            out.insert("SUPERAI_PROXY_SOURCE".to_string(), "pac".to_string());
            // Loopback must never be proxied whatever the script decides: the
            // CLI subprocess dials back to ws://127.0.0.1.
            out.entry("NO_PROXY".to_string())
                .or_insert_with(|| windows_bypass_to_no_proxy(&system.bypass));
        }
        SystemProxyChoice::Static(url) => {
            let no_proxy = windows_bypass_to_no_proxy(&system.bypass);
            println!("[desktop] proxy: source=system {url} (NO_PROXY={no_proxy})");
            out.insert("HTTPS_PROXY".to_string(), url.clone());
            out.insert("HTTP_PROXY".to_string(), url);
            // A NO_PROXY the user set in settings.json stays authoritative.
            out.entry("NO_PROXY".to_string()).or_insert(no_proxy);
            out.insert("SUPERAI_PROXY_SOURCE".to_string(), "system".to_string());
        }
        SystemProxyChoice::Direct => {
            println!("[desktop] proxy: source=none (direct)");
            out.insert("SUPERAI_PROXY_SOURCE".to_string(), "none".to_string());
        }
    }

    out
}

/// Export the operating system's trusted CA certificates to a PEM file and
/// return the env that makes the Bun sidecars trust them.
///
/// Corporate networks terminate TLS at a proxy that re-signs every site with
/// a company CA. That CA lives in the OS store (browsers work), but Bun only
/// trusts its bundled Mozilla roots, so every provider test / chat / IM call
/// from the sidecars failed with "self signed certificate in certificate
/// chain". Bun reads NODE_EXTRA_CA_CERTS ONLY at process boot (setting it
/// inside the sidecar later is a no-op), so it must be in the spawn env -
/// exactly like HTTPS_PROXY above.
///
/// Respected overrides: a NODE_EXTRA_CA_CERTS already in the desktop's own
/// environment or in ~/.claude/superai/settings.json wins (the user chose a
/// bundle); SUPERAI_USE_SYSTEM_CA=0 disables the export. The file is written
/// to ~/.claude/superai/system-ca.pem and refreshed on every start.
fn read_system_ca_env() -> HashMap<String, String> {
    let mut out = HashMap::new();
    if std::env::var_os("NODE_EXTRA_CA_CERTS").is_some_and(|v| !v.is_empty()) {
        return out;
    }
    if let Ok(v) = std::env::var("SUPERAI_USE_SYSTEM_CA") {
        let v = v.trim().to_ascii_lowercase();
        if matches!(v.as_str(), "0" | "false" | "no" | "off") {
            return out;
        }
    }
    let Some(home) = home_dir() else {
        return out;
    };
    let superai_dir = home.join(".claude").join("superai");
    // A NODE_EXTRA_CA_CERTS the user put into settings.json env wins.
    if let Ok(raw) = std::fs::read_to_string(superai_dir.join("settings.json")) {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(v) = parsed
                .get("env")
                .and_then(|e| e.get("NODE_EXTRA_CA_CERTS"))
                .and_then(|v| v.as_str())
            {
                if !v.is_empty() {
                    out.insert("NODE_EXTRA_CA_CERTS".to_string(), v.to_string());
                    return out;
                }
            }
        }
    }

    let result = rustls_native_certs::load_native_certs();
    if result.certs.is_empty() {
        if !result.errors.is_empty() {
            println!(
                "[desktop] OS certificate store unavailable ({} errors); sidecars use bundled roots",
                result.errors.len()
            );
        }
        return out;
    }
    let mut pem = String::new();
    for cert in &result.certs {
        pem.push_str("-----BEGIN CERTIFICATE-----\n");
        let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, cert.as_ref());
        for chunk in b64.as_bytes().chunks(64) {
            pem.push_str(str::from_utf8(chunk).unwrap_or(""));
            pem.push('\n');
        }
        pem.push_str("-----END CERTIFICATE-----\n");
    }
    if std::fs::create_dir_all(&superai_dir).is_err() {
        return out;
    }
    let pem_path = superai_dir.join("system-ca.pem");
    if let Err(err) = std::fs::write(&pem_path, pem) {
        println!("[desktop] could not write {}: {err}", pem_path.display());
        return out;
    }
    println!(
        "[desktop] exported {} OS CA certificates to {} (NODE_EXTRA_CA_CERTS for sidecars)",
        result.certs.len(),
        pem_path.display()
    );
    out.insert(
        "NODE_EXTRA_CA_CERTS".to_string(),
        pem_path.to_string_lossy().to_string(),
    );
    out
}

fn start_server_sidecar(app: &AppHandle) -> Result<ServerRuntime, String> {
    let host = "127.0.0.1";
    let port = reserve_local_port()?;
    let url = format!("http://{host}:{port}");
    let app_root = resolve_app_root(app)?;
    let app_root_arg = app_root.to_string_lossy().to_string();

    // 单一合并 sidecar：第一个参数选 server / cli / adapters 模式。
    let mut proxy_env = resolve_proxy_env();
    proxy_env.extend(read_system_ca_env());
    if !proxy_env.is_empty() {
        let keys: Vec<&str> = proxy_env.keys().map(|s| s.as_str()).collect();
        println!("[desktop] injecting proxy/TLS env into server sidecar: {:?}", keys);
    }
    let mut sidecar = app
        .shell()
        .sidecar("superai-agent-sidecar")
        .map_err(|err| format!("resolve sidecar: {err}"))?
        .args([
            "server",
            "--app-root",
            &app_root_arg,
            "--host",
            host,
            "--port",
            &port.to_string(),
        ]);
    for (k, v) in &proxy_env {
        sidecar = sidecar.env(k, v);
    }

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|err| format!("spawn server sidecar: {err}"))?;

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line = String::from_utf8_lossy(&line);
                    println!("[claude-server] {}", line.trim_end());
                }
                CommandEvent::Stderr(line) => {
                    let line = String::from_utf8_lossy(&line);
                    eprintln!("[claude-server] {}", line.trim_end());
                }
                _ => {}
            }
        }
    });

    wait_for_server(host, port)?;

    Ok(ServerRuntime { url, child })
}

fn stop_server_sidecar(app: &AppHandle) {
    let Some(state) = app.try_state::<ServerState>() else {
        return;
    };

    let Ok(mut guard) = state.0.lock() else {
        return;
    };

    if let Some(runtime) = guard.runtime.take() {
        let _ = runtime.child.kill();
    }
}

/// 启动 adapter sidecar。返回 Result 主要为了把"无法 spawn"和"spawn 后立刻
/// 退出（凭据缺失）"区分开 —— 后者不算错误，是正常 default 状态。
fn start_adapters_sidecar(app: &AppHandle) -> Result<CommandChild, String> {
    let app_root = resolve_app_root(app)?;
    let app_root_arg = app_root.to_string_lossy().to_string();

    // adapter 内部的 WsBridge 默认连 ws://127.0.0.1:3456，但桌面端的 server
    // 用的是 reserve_local_port() 拿到的动态端口。这里把实际端口通过
    // ADAPTER_SERVER_URL env var 传过去 —— adapters/common/config.ts 的
    // loadConfig() 会读它。
    //
    // 如果 server 还没起来 / 没拿到 URL，回退到 3456 作为最后兜底（adapter
    // 自己有重连逻辑，等 server 上线就能连上）。
    let server_http_url = app
        .try_state::<ServerState>()
        .and_then(|state| {
            state
                .0
                .lock()
                .ok()
                .and_then(|guard| guard.runtime.as_ref().map(|r| r.url.clone()))
        })
        .unwrap_or_else(|| "http://127.0.0.1:3456".to_string());
    // WsBridge 直接 `new WebSocket('${serverUrl}/ws/...')`，必须传 ws://；
    // 不会自动从 http 转。
    let server_ws_url = if let Some(rest) = server_http_url.strip_prefix("http://") {
        format!("ws://{rest}")
    } else if let Some(rest) = server_http_url.strip_prefix("https://") {
        format!("wss://{rest}")
    } else {
        server_http_url.clone()
    };

    let mut proxy_env = resolve_proxy_env();
    proxy_env.extend(read_system_ca_env());
    let mut sidecar = app
        .shell()
        .sidecar("superai-agent-sidecar")
        .map_err(|err| format!("resolve sidecar: {err}"))?
        .env("ADAPTER_SERVER_URL", &server_ws_url)
        .args([
            "adapters",
            "--app-root",
            &app_root_arg,
            "--feishu",
            "--telegram",
            "--wechat",
        ]);
    for (k, v) in &proxy_env {
        sidecar = sidecar.env(k, v);
    }

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|err| format!("spawn adapter sidecar: {err}"))?;

    // 用一个 async task 把 sidecar 的 stdout/stderr 转发出来。它退出时
    // 整个 task 也会自然结束。
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line = String::from_utf8_lossy(&line);
                    println!("[claude-adapters] {}", line.trim_end());
                }
                CommandEvent::Stderr(line) => {
                    let line = String::from_utf8_lossy(&line);
                    eprintln!("[claude-adapters] {}", line.trim_end());
                }
                CommandEvent::Terminated(payload) => {
                    // exit code != 0 是常态：用户没配凭据时 sidecar 内部会
                    // warn + skip + process.exit(1)。这里只 info 一行，
                    // 不要当错误冒泡。
                    println!(
                        "[claude-adapters] sidecar exited (code={:?}, signal={:?})",
                        payload.code, payload.signal
                    );
                }
                _ => {}
            }
        }
    });

    Ok(child)
}

/// spawn adapter sidecar 并把 child handle 存进 AdapterState。
/// 在启动 + 重启路径里复用，集中处理"无法 spawn"的日志。
fn spawn_and_track_adapters_sidecar(app: &AppHandle) {
    match start_adapters_sidecar(app) {
        Ok(child) => {
            if let Some(state) = app.try_state::<AdapterState>() {
                if let Ok(mut guard) = state.0.lock() {
                    *guard = Some(child);
                }
            }
        }
        Err(err) => {
            eprintln!("[desktop] failed to start adapter sidecar: {err}");
        }
    }
}

fn stop_adapters_sidecar(app: &AppHandle) {
    let Some(state) = app.try_state::<AdapterState>() else {
        return;
    };
    let Ok(mut guard) = state.0.lock() else {
        return;
    };
    if let Some(child) = guard.take() {
        let _ = child.kill();
    }
}

#[cfg(target_os = "windows")]
fn kill_windows_sidecars() {
    for image_name in [
        "superai-agent-sidecar-x86_64-pc-windows-msvc.exe",
        "superai-agent-sidecar-aarch64-pc-windows-msvc.exe",
        "superai-agent-sidecar.exe",
        "superai-agent-tui-x86_64-pc-windows-msvc.exe",
        "superai-agent-tui.exe",
    ] {
        let _ = StdCommand::new("taskkill")
            .args(["/F", "/T", "/IM", image_name])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(test)]
mod tests {
    use super::{
        decode_terminal_output, default_utf8_locale, ensure_utf8_locale, parse_env_block,
        pick_windows_proxy_url, windows_bypass_to_no_proxy,
    };
    use std::collections::HashMap;

    /// Exercises the real registry read, not just the parsing. A typo in the
    /// `Internet Settings` subkey path (or a wrong value type for the
    /// ProxyEnable DWORD) would silently yield None and send every corporate
    /// machine back to direct egress — the exact bug this feature fixes.
    #[cfg(windows)]
    #[test]
    fn system_proxy_key_is_readable_on_windows() {
        let system = super::read_system_proxy().expect("Internet Settings key must be readable");
        println!(
            "[this machine] ProxyEnable={} ProxyServer={:?} AutoConfigURL={:?}",
            system.enabled, system.server, system.pac
        );
        // Whatever this machine is configured for, the derived values must be
        // self-consistent: a proxy URL is only produced when it is enabled.
        if !system.enabled {
            assert_eq!(
                super::pick_windows_proxy_url(&system.server).is_some() && system.enabled,
                false
            );
        }
    }

    fn sys(enabled: bool, server: &str, pac: &str) -> super::SystemProxy {
        super::SystemProxy {
            enabled,
            server: server.to_string(),
            bypass: String::new(),
            pac: pac.to_string(),
        }
    }

    /// The bug the user found: Windows honours AutoConfigURL even when
    /// ProxyEnable is 0, so a "disabled" registry is not a direct machine.
    #[test]
    fn pac_wins_even_when_proxy_enable_is_zero() {
        assert_eq!(
            super::choose_system_proxy(&sys(false, "", "http://wpad.corp/proxy.pac")),
            super::SystemProxyChoice::Pac("http://wpad.corp/proxy.pac".to_string())
        );
    }

    /// And it outranks a static ProxyServer when both are configured.
    #[test]
    fn pac_outranks_a_static_proxy_server() {
        assert_eq!(
            super::choose_system_proxy(&sys(true, "static.corp:8080", "http://wpad.corp/p.pac")),
            super::SystemProxyChoice::Pac("http://wpad.corp/p.pac".to_string())
        );
    }

    #[test]
    fn static_proxy_is_used_only_when_enabled_and_no_pac() {
        assert_eq!(
            super::choose_system_proxy(&sys(true, "static.corp:8080", "")),
            super::SystemProxyChoice::Static("http://static.corp:8080".to_string())
        );
        // ProxyEnable=0 with no PAC really is direct.
        assert_eq!(
            super::choose_system_proxy(&sys(false, "static.corp:8080", "")),
            super::SystemProxyChoice::Direct
        );
        assert_eq!(super::choose_system_proxy(&sys(true, "", "")), super::SystemProxyChoice::Direct);
    }

    #[test]
    fn windows_proxy_bare_value_applies_to_every_scheme() {
        assert_eq!(
            pick_windows_proxy_url("proxy.corp.example:8080").as_deref(),
            Some("http://proxy.corp.example:8080")
        );
    }

    #[test]
    fn windows_proxy_per_scheme_list_prefers_https_then_http() {
        assert_eq!(
            pick_windows_proxy_url("http=h1.corp:80;https=h2.corp:443;ftp=h3.corp:21").as_deref(),
            Some("http://h2.corp:443")
        );
        assert_eq!(
            pick_windows_proxy_url("ftp=h3.corp:21;http=h1.corp:80").as_deref(),
            Some("http://h1.corp:80")
        );
    }

    #[test]
    fn windows_proxy_ignores_socks_only_and_empty_values() {
        // Bun's fetch speaks HTTP CONNECT; a SOCKS endpoint in HTTPS_PROXY
        // fails more confusingly than going direct.
        assert_eq!(pick_windows_proxy_url("socks=s.corp:1080"), None);
        assert_eq!(pick_windows_proxy_url("socks.corp:1080"), None);
        assert_eq!(pick_windows_proxy_url("   "), None);
        assert_eq!(pick_windows_proxy_url("http=;https="), None);
    }

    #[test]
    fn windows_proxy_keeps_an_explicit_scheme() {
        assert_eq!(
            pick_windows_proxy_url("http://proxy.corp:3128").as_deref(),
            Some("http://proxy.corp:3128")
        );
    }

    #[test]
    fn windows_bypass_normalizes_wildcards_and_drops_local_token() {
        assert_eq!(
            windows_bypass_to_no_proxy("<local>;*.corp.example;10.*"),
            ".corp.example,10.*,localhost,127.0.0.1,::1"
        );
    }

    #[test]
    fn windows_bypass_always_includes_loopback_without_duplicating_it() {
        // The spawned CLI dials ws://127.0.0.1 back to the local server; if
        // that is proxied the chat hangs forever (see read_managed_proxy_env).
        assert_eq!(
            windows_bypass_to_no_proxy(""),
            "localhost,127.0.0.1,::1"
        );
        assert_eq!(
            windows_bypass_to_no_proxy("LocalHost;127.0.0.1"),
            "LocalHost,127.0.0.1,::1"
        );
    }

    #[test]
    fn terminal_output_decoder_preserves_split_chinese_characters() {
        let mut pending = Vec::new();
        let bytes = "安装 Skills 成功\n".as_bytes();

        assert_eq!(decode_terminal_output(&mut pending, &bytes[..2]), "");
        assert_eq!(decode_terminal_output(&mut pending, &bytes[2..4]), "安");
        assert_eq!(
            decode_terminal_output(&mut pending, &bytes[4..]),
            "装 Skills 成功\n"
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn terminal_output_decoder_keeps_incomplete_suffix_pending() {
        let mut pending = Vec::new();
        let bytes = "中文".as_bytes();

        assert_eq!(decode_terminal_output(&mut pending, &bytes[..4]), "中");
        assert_eq!(pending, bytes[3..4]);
        assert_eq!(decode_terminal_output(&mut pending, &bytes[4..]), "文");
        assert!(pending.is_empty());
    }

    #[test]
    fn parse_env_block_reads_nul_delimited_values() {
        let env =
            parse_env_block(b"PATH=/opt/homebrew/bin:/usr/bin\0NODE_PATH=/tmp/node\0EMPTY=\0");

        assert_eq!(
            env.get("PATH").map(String::as_str),
            Some("/opt/homebrew/bin:/usr/bin")
        );
        assert_eq!(env.get("NODE_PATH").map(String::as_str), Some("/tmp/node"));
        assert_eq!(env.get("EMPTY").map(String::as_str), Some(""));
    }

    #[test]
    fn terminal_environment_forces_utf8_locale_when_shell_uses_c_locale() {
        let mut env = HashMap::from([
            ("LANG".to_string(), "C".to_string()),
            ("LC_CTYPE".to_string(), "POSIX".to_string()),
            ("LC_ALL".to_string(), "C".to_string()),
        ]);

        ensure_utf8_locale(&mut env);

        assert_eq!(
            env.get("LANG").map(String::as_str),
            Some(default_utf8_locale())
        );
        assert_eq!(
            env.get("LC_CTYPE").map(String::as_str),
            Some(default_utf8_locale())
        );
        assert_eq!(
            env.get("LC_ALL").map(String::as_str),
            Some(default_utf8_locale())
        );
    }

    #[test]
    fn terminal_environment_keeps_existing_utf8_locale() {
        let mut env = HashMap::from([
            ("LANG".to_string(), "zh_CN.UTF-8".to_string()),
            ("LC_CTYPE".to_string(), "en_US.UTF8".to_string()),
            ("LC_ALL".to_string(), "C.UTF-8".to_string()),
        ]);

        ensure_utf8_locale(&mut env);

        assert_eq!(env.get("LANG").map(String::as_str), Some("zh_CN.UTF-8"));
        assert_eq!(env.get("LC_CTYPE").map(String::as_str), Some("en_US.UTF8"));
        assert_eq!(env.get("LC_ALL").map(String::as_str), Some("C.UTF-8"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Must run BEFORE Tauri builds — sidecars are spawned in `setup` and they
    // read process.env at top-level, so injection has to happen first.
    load_portable_env_file();

    let builder = tauri::Builder::default()
        .manage(ServerState::default())
        .manage(AdapterState::default())
        .manage(TerminalState::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_server_url,
            restart_adapters_sidecar,
            prepare_for_update_install,
            terminal_spawn,
            terminal_write,
            terminal_resize,
            terminal_kill
        ]);

    // macOS: native menu bar (traffic-light overlay style)
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(|app| {
            let about_item =
                MenuItemBuilder::with_id("nav_about", "关于 SuperAI Agent").build(app)?;
            let settings_item = MenuItemBuilder::with_id("nav_settings", "设置...")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;

            let app_submenu = SubmenuBuilder::new(app, "SuperAI Agent")
                .item(&about_item)
                .separator()
                .item(&settings_item)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;

            let edit_submenu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            let view_submenu = SubmenuBuilder::new(app, "View").fullscreen().build()?;

            let window_submenu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .maximize()
                .close_window()
                .build()?;

            MenuBuilder::new(app)
                .item(&app_submenu)
                .item(&edit_submenu)
                .item(&view_submenu)
                .item(&window_submenu)
                .build()
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "nav_about" => {
                let _ = app.emit("native-menu-navigate", "about");
            }
            "nav_settings" => {
                let _ = app.emit("native-menu-navigate", "settings");
            }
            _ => {}
        });

    let app = builder
        .setup(|app| {
            let state = app.state::<ServerState>();
            let mut guard = state
                .0
                .lock()
                .map_err(|_| IoError::new(ErrorKind::Other, "server state lock poisoned"))?;

            match start_server_sidecar(&app.handle()) {
                Ok(runtime) => {
                    guard.runtime = Some(runtime);
                    guard.startup_error = None;
                }
                Err(err) => {
                    eprintln!("[desktop] failed to start local server: {err}");
                    guard.runtime = None;
                    guard.startup_error = Some(err);
                }
            }
            drop(guard);

            // server 起来之后再起 adapter sidecar —— start_adapters_sidecar
            // 内部会从 ServerState 读 server URL 注入 ADAPTER_SERVER_URL env，
            // 让 adapter 连上动态端口。
            spawn_and_track_adapters_sidecar(&app.handle());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            stop_server_sidecar(app_handle);
            stop_adapters_sidecar(app_handle);
        }
    });
}
