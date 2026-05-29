# 相对于原始泄露源码的修复


泄露的源码无法直接运行，主要修复了以下问题：

| 问题 | 根因 | 修复 |
|------|------|------|
| TUI 不启动 | 入口脚本把无参数启动路由到了 recovery CLI | 恢复走 `cli.tsx` 完整入口 |
| 启动卡死 | `verify` skill 导入缺失的 `.md` 文件，Bun text loader 无限挂起 | 创建 stub `.md` 文件 |
| `--print` 卡死 | `filePersistence/types.ts` 缺失 | 创建类型桩文件 |
| `--print` 卡死 | `ultraplan/prompt.txt` 缺失 | 创建资源桩文件 |
| **Enter 键无响应** | `modifiers-napi` native 包缺失，`isModifierPressed()` 抛异常导致 `handleEnter` 中断，`onSubmit` 永远不执行 | 加 try-catch 容错 |
| setup 被跳过 | `preload.ts` 自动设置 `LOCAL_RECOVERY=1` 跳过全部初始化 | 移除默认设置 |

## Codex 提供商 Windows 适配修复（v0.2.2）

| 问题 | 根因 | 修复 |
|------|------|------|
| `codex` 启动 ENOENT | Bun.spawn 直接调用裸 `codex` 时找不到 npm 全局 shim | 增加 `resolveCodexCommand()`：依次尝试 `CODEX_CLI_PATH` → PATH 查找 → `~/.npm-global/bin/codex` → `~/.bun/bin/codex` 等绝对路径 |
| Codex 永远卡在 `Reading additional input from stdin...` | `stdin: 'ignore'` 通过 cmd.exe `.cmd` shim 时不会真正关闭子进程 stdin | 改用 `stdin: 'pipe'` 并在 spawn 之后立即 `proc.stdin?.end?.()` 显式发送 EOF |
| 子进程 `codex-windows-sandbox-setup.exe` 残留累积 | `proc.kill()` 在 Windows 上不传递到子进程 | 通过 `shouldUseTaskkill(platform, pid)` 守卫，命中时用 `taskkill /F /T /PID <pid>` 杀掉整棵进程树 |
| 反复登录后 ChatGPT 令牌被吊销 | 每次成功登录会轮换 refresh token，新设备登录会吊销旧设备 | 桌面 Settings 的 "Sign in to Codex" 按钮先发 `codex logout` 再发 `codex login`，每次都从干净状态开始 OAuth |
| 桌面端 sidecar 走系统代理失败 | Bun 在启动时快照 env，sidecar 进程一直继承宿主代理 | Tauri 启动 sidecar 时显式注入 `NO_PROXY=loopback` 让本机 WS 旁路代理 |
