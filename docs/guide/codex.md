# OpenAI Codex 接入

SuperAI Agent 内置 **OpenAI Codex** 官方提供商。会话会直接驱动本机安装的 `codex` CLI，复用你已经登录的 ChatGPT 账号，**不需要 `OPENAI_API_KEY`**。

适用场景：
- 已经订阅了 ChatGPT Plus / Pro / Team，想免去额外的 API 计费。
- 不方便管理或轮转 OpenAI API Key。
- 想在同一个桌面端里同时使用 Anthropic、Codex 两类模型。

---

## 1. 安装 Codex CLI

在 Node.js 18+ 环境下：

```bash
npm install -g @openai/codex
```

验证：

```bash
codex --version
```

> 桌面端会按以下顺序查找 `codex` 可执行文件：
> 1. 环境变量 `CODEX_CLI_PATH`
> 2. 当前 `PATH` 上的 `codex`
> 3. `~/.npm-global/bin/codex`
> 4. `~/.bun/bin/codex`
> 5. `/opt/homebrew/bin/codex`、`/usr/local/bin/codex`
>
> 如果你用的是非标准安装位置，把绝对路径写到 `CODEX_CLI_PATH` 即可。

---

## 2. 登录 ChatGPT 账号

在 SuperAI Agent 桌面端：

1. 打开 **Settings → Codex Official Login**
2. 点击 **「登录 Codex 账号」**
3. 内置终端会自动执行：
   ```
   codex logout
   codex login
   ```
4. 按 Codex CLI 的提示在浏览器里完成 OAuth 授权

登录态保存在 `~/.codex/auth.json`，由 Codex CLI 自行刷新，SuperAI Agent 不会读写其中的 token。

> **为什么先 `codex logout`？** ChatGPT OAuth 在每次成功登录时会轮换 refresh token，新设备登录会让旧设备的 refresh token 失效。先 logout 再 login，可以避免和旧的、已经被吊销的 token 互相干扰。

---

## 3. 在会话中使用 Codex

在新建会话时把 runtime 选成 **Codex**（或直接选一个 Codex 模型，如 `gpt-5-codex`）。会话流程和 Anthropic 一致：

- 工具调用、权限提示、文件 diff 都走桌面端统一的 UI
- 权限模式映射：
  - `bypassPermissions` → `codex exec --dangerously-bypass-approvals-and-sandbox`
  - `plan` → `codex exec -a never -s read-only`
  - 其他 → `codex exec -a never -s workspace-write`

模型读取自 `~/.claude/superai/settings.json` 里的 `model` 字段；不写就走默认值 `OPENAI_CODEX_DEFAULT_MODEL_ID`。

---

## 4. 常见问题（Windows）

| 现象 | 原因 | 解决 |
|------|------|------|
| `codex` 找不到 / ENOENT | npm 全局 shim 是 `.cmd`，没在 PATH 上 | 重新打开终端，或把 `%APPDATA%\npm` 加到 PATH；也可以设置 `CODEX_CLI_PATH` |
| 一直停在 `Reading additional input from stdin...` | 旧版本里 `.cmd` shim 会继承 stdin。v0.2.2 起已经改成 spawn 后立即关闭 stdin，升级到最新便携包即可 | 升级到 v0.2.2+ |
| 停止会话后 `codex-windows-sandbox-setup.exe` 还在跑 | Windows 上 `proc.kill()` 不传递到子进程。v0.2.2 起改用 `taskkill /F /T /PID` 杀掉整棵树 | 升级到 v0.2.2+；遗留进程用 `Get-Process codex*` + `Stop-Process` 手动清理 |
| 反复登录后报 `token_invalidated` / `refresh_token_invalidated` | 在多台机器之间互相挤掉了 refresh token | 在 Settings 里点 **「登录 Codex 账号」** 走一次完整的 logout + login |
| 桌面端连不上 sidecar，浏览器能连 | 系统代理把 `127.0.0.1` 也代理了 | v0.2.2 起 Tauri 会注入 `NO_PROXY=loopback`，升级到最新便携包；旧版可以手动在系统里把 `localhost,127.0.0.1` 加到 NO_PROXY |

---

## 5. 相关代码

- `src/server/services/conversationService.ts` — `runtime: 'codex'` 分支、`resolveCodexCommand`、`buildCodexExecArgs`、`resolveCodexModel`、`shouldUseTaskkill`
- `desktop/src/components/settings/CodexOfficialLogin.tsx` — 桌面端登录入口
- `src/server/__tests__/codex-timeout.test.ts` — 超时与 Windows 进程清理的单元测试
