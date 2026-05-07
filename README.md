# SuperAI Agent

<p align="center">
  <img src="docs/images/app-icon.png" alt="SuperAI Agent" width="240">
</p>

<div align="center">

[![GitHub Stars](https://img.shields.io/github/stars/jsun2020/superai-agent?style=social)](https://github.com/jsun2020/superai-agent/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/jsun2020/superai-agent?style=social)](https://github.com/jsun2020/superai-agent/network/members)
[![GitHub Issues](https://img.shields.io/github/issues/jsun2020/superai-agent)](https://github.com/jsun2020/superai-agent/issues)
[![GitHub Pull Requests](https://img.shields.io/github/issues-pr/jsun2020/superai-agent)](https://github.com/jsun2020/superai-agent/pulls)
[![License](https://img.shields.io/github/license/jsun2020/superai-agent)](https://github.com/jsun2020/superai-agent/blob/main/LICENSE)
[![中文](https://img.shields.io/badge/🇨🇳_中文-当前-blue)](README.md)
[![English](https://img.shields.io/badge/🇺🇸_English-Available-green)](README.en.md)

</div>

SuperAI Agent 是一个本地可运行的 AI 编码代理：完整的终端 TUI、图形化**桌面端**，支持任意 Anthropic 兼容 API（MiniMax、OpenRouter 等）。内置 Computer Use（macOS / Windows）、记忆系统、多 Agent 编排，并可通过 Telegram / 飞书 / 微信公众号**完整远程驱动**。

<p align="center">
  <a href="#功能">功能</a> · <a href="#桌面端">桌面端</a> · <a href="#快速开始">快速开始</a> · <a href="docs/guide/env-vars.md">环境变量</a> · <a href="docs/guide/faq.md">FAQ</a> · <a href="docs/guide/global-usage.md">全局使用</a> · <a href="#更多文档">更多文档</a>
</p>

---

## 功能

- 完整的 Ink TUI 交互界面（与官方 Claude Code 一致）
- `--print` 无头模式（脚本/CI 场景）
- 支持 MCP 服务器、插件、Skills
- 支持自定义 API 端点和模型（[第三方模型使用指南](docs/guide/third-party-models.md)）
- **记忆系统**（跨会话持久化记忆）— [使用指南](docs/memory/01-usage-guide.md)
- **多 Agent 系统**（多代理编排、并行任务、Teams 协作）— [使用指南](docs/agent/01-usage-guide.md) | [实现原理](docs/agent/02-implementation.md)
- **Skills 系统**（可扩展能力插件、自定义工作流）— [使用指南](docs/skills/01-usage-guide.md) | [实现原理](docs/skills/02-implementation.md)
- **Channel 系统**（通过 Telegram/飞书/Discord 等 IM 远程控制 Agent）— [架构解析](docs/channel/01-channel-system.md)
- **Computer Use 桌面控制** — [功能指南](docs/features/computer-use.md) | [架构解析](docs/features/computer-use-architecture.md)
- **桌面端**（Tauri 2 + React 图形化客户端，多标签多会话）— [文档](docs/desktop/)
- 降级 Recovery CLI 模式（`CLAUDE_CODE_FORCE_RECOVERY_CLI=1 ./bin/superai-agent`）

---

## 桌面端

<p align="center">
  <a href="https://github.com/jsun2020/superai-agent/releases"><img src="https://img.shields.io/badge/⬇_下载桌面端-macOS_%7C_Windows-D97757?style=for-the-badge" alt="下载桌面端"></a>
  &nbsp;
  <a href="docs/desktop/04-installation.md"><img src="https://img.shields.io/badge/📖_安装指南-Guide-gray?style=for-the-badge" alt="安装指南"></a>
</p>

桌面端基于 Tauri 2 + React，支持多标签多会话、代码编辑与 Diff、权限控制、多提供商管理、定时任务，以及 Telegram / 飞书 / 微信公众号 IM 适配器。详见 [桌面端文档](docs/desktop/)。

---

## 快速开始

### 1. 安装 Bun

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# macOS (Homebrew)
brew install bun

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"
```

> 精简版 Linux 如提示 `unzip is required`，先运行 `apt update && apt install -y unzip`

### 2. 安装依赖并配置

```bash
bun install
cp .env.example .env
# 编辑 .env 填入你的 API Key，详见 docs/guide/env-vars.md
```

### 3. 启动

#### macOS / Linux

```bash
./bin/superai-agent                          # 交互 TUI 模式
./bin/superai-agent -p "your prompt here"    # 无头模式
./bin/superai-agent --help                   # 查看所有选项
```

#### Windows

> **前置要求**：必须安装 [Git for Windows](https://git-scm.com/download/win)

```powershell
# PowerShell / cmd 直接调用 Bun
bun --env-file=.env ./src/entrypoints/cli.tsx

# 或在 Git Bash 中运行
./bin/superai-agent
```

### 4. 全局使用（可选）

将 `bin/` 加入 PATH 后可在任意目录启动，详见 [全局使用指南](docs/guide/global-usage.md)：

```bash
export PATH="$HOME/path/to/superai-agent/bin:$PATH"
```

### 5. 桌面端联调（Desktop）

如果你在开发或测试 `desktop/` 前端，需要同时启动 API 服务端和桌面前端。

#### 5.1 启动服务端

在项目根目录运行：

```bash
SERVER_PORT=3456 bun run src/server/index.ts
```

可选自检：

```bash
curl http://127.0.0.1:3456/health
```

#### 5.2 启动桌面前端

```bash
cd desktop
bun run dev --host 127.0.0.1 --port 2024
```

然后在浏览器打开：

```text
http://127.0.0.1:2024
```

#### 5.3 常见注意事项

- 如果 `3456` 端口已经被旧服务端占用，先执行 `lsof -nP -iTCP:3456 -sTCP:LISTEN` 找到 PID，再 `kill <PID>`。
- 测试聊天时建议新建一个 session，并重新选择一个真实存在的工作目录。
- 如果某个旧 session 绑定的目录已被删除，服务端会返回 `Working directory does not exist`，这和服务端是否启动是两回事。

---

## 技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | [Bun](https://bun.sh) |
| 语言 | TypeScript |
| 终端 UI | React + [Ink](https://github.com/vadimdemedes/ink) |
| CLI 解析 | Commander.js |
| API | Anthropic SDK |
| 协议 | MCP, LSP |

---

## 更多文档

| 文档 | 说明 |
|------|------|
| [环境变量](docs/guide/env-vars.md) | 完整环境变量参考和配置方式 |
| [第三方模型](docs/guide/third-party-models.md) | 接入 OpenAI / DeepSeek / Ollama 等非 Anthropic 模型 |
| [记忆系统](docs/memory/01-usage-guide.md) | 跨会话持久化记忆的使用与实现 |
| [多 Agent 系统](docs/agent/01-usage-guide.md) | 多代理编排、并行任务执行与 Teams 协作 |
| [Skills 系统](docs/skills/01-usage-guide.md) | 可扩展能力插件、自定义工作流与条件激活 |
| [Channel 系统](docs/channel/01-channel-system.md) | 通过 Telegram/飞书/Discord 等 IM 平台远程控制 Agent |
| [Computer Use](docs/features/computer-use.md) | 桌面控制功能（截屏、鼠标、键盘）— [架构解析](docs/features/computer-use-architecture.md) |
| [桌面端](docs/desktop/) | Tauri 2 + React 图形化客户端 — [快速上手](docs/desktop/01-quick-start.md) \| [架构设计](docs/desktop/02-architecture.md) \| [安装指南](docs/desktop/04-installation.md) |
| [全局使用](docs/guide/global-usage.md) | 在任意目录启动 superai-agent |
| [常见问题](docs/guide/faq.md) | 常见错误排查 |
| [源码修复记录](docs/reference/fixes.md) | 相对于原始泄露源码的修复内容 |
| [项目结构](docs/reference/project-structure.md) | 代码目录结构说明 |

---


## 免责声明

本项目仅供学习与研究使用。使用过程中请遵守所对接 API 服务商的服务条款与相关法律法规。Claude Code 上游版权归 [Anthropic](https://www.anthropic.com) 所有。
