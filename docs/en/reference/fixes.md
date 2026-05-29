# Fixes Compared with the Original Leaked Source


The leaked source could not run directly. This repository mainly fixes the following issues:

| Issue | Root cause | Fix |
|------|------|------|
| TUI does not start | The entry script routed no-argument startup to the recovery CLI | Restored the full `cli.tsx` entry |
| Startup hangs | The `verify` skill imports a missing `.md` file, causing Bun's text loader to hang indefinitely | Added stub `.md` files |
| `--print` hangs | `filePersistence/types.ts` was missing | Added type stub files |
| `--print` hangs | `ultraplan/prompt.txt` was missing | Added resource stub files |
| **Enter key does nothing** | The `modifiers-napi` native package was missing, `isModifierPressed()` threw, `handleEnter` was interrupted, and `onSubmit` never ran | Added try/catch fault tolerance |
| Setup was skipped | `preload.ts` automatically set `LOCAL_RECOVERY=1`, skipping all initialization | Removed the default setting |

## Codex Provider Windows Hardening (v0.2.2)

| Issue | Root cause | Fix |
|------|------|------|
| `codex` spawn ENOENT | `Bun.spawn` cannot find the npm-global `.cmd` shim when invoked as bare `codex` | Added `resolveCodexCommand()` that tries `CODEX_CLI_PATH` → PATH lookup → `~/.npm-global/bin/codex` → `~/.bun/bin/codex` → Homebrew / `/usr/local` paths in order |
| Codex hangs forever at `Reading additional input from stdin...` | `stdin: 'ignore'` does not actually close the child's stdin when launched through a `cmd.exe` `.cmd` shim | Use `stdin: 'pipe'` and call `proc.stdin?.end?.()` immediately after spawn to force an EOF |
| Orphan `codex-windows-sandbox-setup.exe` accumulates after stops | `proc.kill()` does not propagate to children on Windows | Added a `shouldUseTaskkill(platform, pid)` guard and call `taskkill /F /T /PID <pid>` when it matches |
| ChatGPT tokens get revoked after repeated logins | Each successful OAuth login rotates the refresh token; a new device's login invalidates the old device's refresh | The desktop "Sign in to Codex" button always sends `codex logout` before `codex login` so each round starts clean |
| Sidecar cannot reach `127.0.0.1` because of corporate proxy | Bun snapshots env at process start; the sidecar inherits the host's `HTTPS_PROXY` | Tauri injects `NO_PROXY=loopback` into the spawned sidecar env so the local WS bypasses the proxy |
