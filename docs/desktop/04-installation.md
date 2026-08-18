# 安装指南

## Windows：便携版（推荐）

便携版是一个解压即用的文件夹，不写注册表、不需要管理员权限，复制到任何位置都能运行。

1. 从 [GitHub Releases](https://github.com/jsun2020/superai-agent/releases) 下载 `SuperAIAgent-Portable-vX.Y.Z.zip`（也可以自己用 `scripts/build-portable.ps1` 打包，产物在 `dist/portable/` 与 `dist/SuperAIAgent-Portable-vX.Y.Z.zip`）
2. 解压到任意目录，双击 **`SuperAIAgent.exe`**
3. 首次启动（还没有任何会话时）会先停在 **设置 → 服务商**：点「Add Provider」填入 API Key（或选择 Claude / OpenAI 官方登录），然后点左上角 **New session** 开始对话

解压后的目录：

| 文件 | 说明 |
|------|------|
| `SuperAIAgent.exe` | 桌面端（双击这个） |
| `superai.exe` | 同一套引擎的**终端 UI**，在命令行里运行；`superai-agent-tui.exe` 是它的长名字 |
| `superai-agent-sidecar.exe` | 内部后台进程（API 服务 + IM 适配器），由桌面端自动启动，**不要手动双击** |
| `*-x86_64-pc-windows-msvc.exe` | Tauri 需要的按目标平台命名的别名，同一个文件 |
| `.env.example` | 环境变量模板；一般不需要，服务商在设置页里配置即可 |
| `vendor\officecli.exe` | 内置的 OfficeCLI 文档引擎，供办公文档 agent 处理 Word / Excel / PowerPoint |
| `README-portable.txt` | 随包附带的简要说明（含终端会话 `-c` / `-r` / `/compact` 用法） |

> **WebView2**：桌面端依赖 Microsoft Edge WebView2 运行时，Windows 11 和更新过的 Windows 10 已自带。若启动时提示缺少 WebView2，从 [微软官网](https://developer.microsoft.com/microsoft-edge/webview2/) 安装 Evergreen Bootstrapper。

> **SmartScreen**：程序未做 Windows 代码签名，首次运行若弹出警告，点「更多信息」→「仍要运行」。

## GitHub Release 安装包

`v0.2.17` 起，`.github/workflows/release-desktop.yml` 会在推送 `vX.Y.Z` 标签时构建并发布：

| 平台 | 文件 |
|------|------|
| Windows (x64) | `SuperAI-Agent_X.Y.Z_windows_x64_nsis.exe`（NSIS 安装包，供应用内更新使用） |
| macOS (Apple Silicon) | `SuperAI-Agent_X.Y.Z_macos_arm64_dmg.dmg` |
| macOS (Intel) | `SuperAI-Agent_X.Y.Z_macos_x64_dmg.dmg` |
| Linux (x64 / ARM64) | `SuperAI-Agent_X.Y.Z_linux_x64_deb.deb` / `…_linux_arm64_deb.deb` |

同一 Release 里的 `latest.json` 就是桌面端「关于 → App Updates → Check now」读取的更新清单。

> 不确定 Mac 架构？点击左上角  → 关于本机，芯片为 Apple M 开头选 aarch64，Intel 选 x64。

## macOS 安装

1. 双击 `.dmg`，把应用拖入 `Applications`
2. 首次打开若提示**"已损坏，无法打开"**，在终端执行：

```bash
xattr -cr "/Applications/SuperAI Agent.app"
```

> 应用暂未做 Apple 开发者签名，macOS 会阻止首次运行，移除隔离属性后即可正常使用。macOS 包同样内置了 OfficeCLI（`Contents/MacOS/vendor/officecli`）。

## 从源码运行 / Web UI 模式

需要 [Bun](https://bun.sh)。桌面端安装遇到问题时，可以直接在浏览器里用 Web UI：

```bash
# 1. 启动服务端（项目根目录）
SERVER_PORT=3456 bun run src/server/index.ts

# 2. 启动前端（desktop 目录）
cd desktop
bun run dev --host 127.0.0.1 --port 2024
```

浏览器访问 `http://127.0.0.1:2024`。开发桌面端本体：`cd desktop && bun run tauri dev`；打包 Windows 便携版：`powershell -File scripts/build-portable.ps1`（`-OutDir` 可指定输出目录，`-StageOnly` 只重新打包不重新编译）。

## 常见问题

**Q: 启动后只看到「设置 → 服务商」页面？**

还没有任何会话时桌面端会先打开设置页，这是正常的。添加一个服务商（或登录 Claude / OpenAI 官方）后点左上角 **New session**。

**Q: 桌面端和 `superai.exe` 终端的配置是分开的吗？**

不是。服务商保存在 `~/.claude/superai/`（`providers.json` + `settings.json`），Work 模式的角色 / 连接器目录在 `~/.superai/`，两边共用；在任一处切换服务商，另一处下次启动就会用它。

**Q: "Update failed: Could not fetch a valid release JSON from the remote"？**

说明 GitHub Release 里还没有 `latest.json`（尚未发布 Release、仓库不公开、或网络无法访问 GitHub）。手动下载新版本 zip 覆盖即可；便携版之间的升级只需替换文件夹里的 exe。

**Q: macOS 提示"来自身份不明的开发者"？**

右键应用 → 「打开」→ 弹窗中再点「打开」，仅需一次。

**Q: Windows 提示缺少 WebView2？**

见上文 WebView2 说明。
