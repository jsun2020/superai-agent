# SuperAI Agent

<p align="center">
  <img src="docs/images/logo.png" alt="SuperAI Agent" width="240">
</p>

<div align="center">

[![GitHub Stars](https://img.shields.io/github/stars/jsun2020/superai-agent?style=social)](https://github.com/jsun2020/superai-agent/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/jsun2020/superai-agent?style=social)](https://github.com/jsun2020/superai-agent/network/members)
[![GitHub Issues](https://img.shields.io/github/issues/jsun2020/superai-agent)](https://github.com/jsun2020/superai-agent/issues)
[![GitHub Pull Requests](https://img.shields.io/github/issues-pr/jsun2020/superai-agent)](https://github.com/jsun2020/superai-agent/pulls)
[![License](https://img.shields.io/github/license/jsun2020/superai-agent)](https://github.com/jsun2020/superai-agent/blob/main/LICENSE)
[![中文](https://img.shields.io/badge/🇨🇳_中文-Available-green)](README.md)
[![English](https://img.shields.io/badge/🇺🇸_English-当前-blue)](README.en.md)

</div>

SuperAI Agent is a locally runnable AI coding agent: a full terminal TUI plus a graphical **desktop client**, with support for any Anthropic-compatible API endpoint (MiniMax, OpenRouter, etc.). It includes Computer Use (macOS / Windows), a memory system, multi-agent orchestration, and **full remote control** via Telegram / Feishu / WeChat Official Account.

<p align="center">
  <a href="#features">Features</a> · <a href="#desktop">Desktop</a> · <a href="#quick-start">Quick Start</a> · <a href="docs/en/guide/env-vars.md">Env Vars</a> · <a href="docs/en/guide/faq.md">FAQ</a> · <a href="docs/en/guide/global-usage.md">Global Usage</a> · <a href="#more-documentation">More Docs</a>
</p>

---

## Features

- Full Ink TUI experience (matching the official Claude Code interface)
- `--print` headless mode for scripts and CI
- MCP server, plugin, and Skills support
- Custom API endpoint and model support ([Third-Party Models Guide](docs/en/guide/third-party-models.md))
- **Memory System** (cross-session persistent memory) — [Usage Guide](docs/memory/01-usage-guide.md)
- **Multi-Agent System** (agent orchestration, parallel tasks, Teams collaboration) — [Usage Guide](docs/agent/01-usage-guide.md) | [Implementation](docs/agent/02-implementation.md)
- **Skills System** (extensible capability plugins, custom workflows) — [Usage Guide](docs/skills/01-usage-guide.md) | [Implementation](docs/skills/02-implementation.md)
- **Channel System** (remote Agent control via Telegram/Feishu/Discord IM platforms) — [Architecture](docs/en/channel/01-channel-system.md)
- **Computer Use desktop control** — [Guide](docs/en/features/computer-use.md) | [Architecture](docs/en/features/computer-use-architecture.md)
- **Desktop App** (Tauri 2 + React GUI client, multi-tab multi-session) — [Docs](docs/desktop/)
- **OpenAI Codex Official Provider** (reuses your ChatGPT login via the local `codex` CLI — no API key required) — [Setup Guide](docs/en/guide/codex.md)
- Fallback Recovery CLI mode (`CLAUDE_CODE_FORCE_RECOVERY_CLI=1 ./bin/superai-agent`)

---

## Desktop

<p align="center">
  <a href="https://github.com/jsun2020/superai-agent/releases"><img src="https://img.shields.io/badge/⬇_Download_Desktop-macOS_%7C_Windows-D97757?style=for-the-badge" alt="Download Desktop"></a>
  &nbsp;
  <a href="docs/desktop/04-installation.md"><img src="https://img.shields.io/badge/📖_Install_Guide-Guide-gray?style=for-the-badge" alt="Install Guide"></a>
</p>

The desktop client is built on Tauri 2 + React, with multi-tab/multi-session support, code editing and diff view, permission control, multi-provider management, scheduled tasks, and Telegram / Feishu / WeChat Official Account IM adapters. See [desktop docs](docs/desktop/).

---

## Quick Start

### 1. Install Bun

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# macOS (Homebrew)
brew install bun

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"
```

> On minimal Linux images, if you see `unzip is required`, run `apt update && apt install -y unzip` first.

### 2. Install Dependencies and Configure

```bash
bun install
cp .env.example .env
# Edit .env with your API key — see docs/en/guide/env-vars.md for details
```

### 3. Start

#### macOS / Linux

```bash
./bin/superai-agent                          # Interactive TUI mode
./bin/superai-agent -p "your prompt here"    # Headless mode
./bin/superai-agent --help                   # Show all options
```

#### Windows

> **Prerequisite**: [Git for Windows](https://git-scm.com/download/win) must be installed.

```powershell
# PowerShell / cmd — call Bun directly
bun --env-file=.env ./src/entrypoints/cli.tsx

# Or run inside Git Bash
./bin/superai-agent
```

### 4. Global Usage (Optional)

Add `bin/` to your PATH to run from any directory. See [Global Usage Guide](docs/en/guide/global-usage.md):

```bash
export PATH="$HOME/path/to/superai-agent/bin:$PATH"
```

### 5. Desktop Development

If you are developing or testing the `desktop/` frontend, start both the API server and the desktop frontend.

#### 5.1 Start the API server

From the project root:

```bash
SERVER_PORT=3456 bun run src/server/index.ts
```

Optional health check:

```bash
curl http://127.0.0.1:3456/health
```

#### 5.2 Start the desktop frontend

```bash
cd desktop
bun run dev --host 127.0.0.1 --port 2024
```

Then open:

```text
http://127.0.0.1:2024
```

#### 5.3 Notes

- If port `3456` is already occupied by an old server process, run `lsof -nP -iTCP:3456 -sTCP:LISTEN`, find the PID, then `kill <PID>`.
- For chat testing, create a fresh session and re-select a real working directory.
- If an old session points to a deleted directory, the server will return `Working directory does not exist`. That is separate from whether the API server is running.

---

## Tech Stack

| Category | Technology |
|------|------|
| Runtime | [Bun](https://bun.sh) |
| Language | TypeScript |
| Terminal UI | React + [Ink](https://github.com/vadimdemedes/ink) |
| CLI parsing | Commander.js |
| API | Anthropic SDK |
| Protocols | MCP, LSP |

---

## More Documentation

| Document | Description |
|------|------|
| [Environment Variables](docs/en/guide/env-vars.md) | Full env var reference and configuration methods |
| [Third-Party Models](docs/en/guide/third-party-models.md) | Using OpenAI / DeepSeek / Ollama and other non-Anthropic models |
| [Codex Integration](docs/en/guide/codex.md) | Use the local `codex` CLI as a provider via your ChatGPT login |
| [Memory System](docs/memory/01-usage-guide.md) | Cross-session persistent memory usage and implementation |
| [Multi-Agent System](docs/agent/01-usage-guide.md) | Agent orchestration, parallel tasks and Teams collaboration |
| [Skills System](docs/skills/01-usage-guide.md) | Extensible capability plugins, custom workflows and conditional activation |
| [Channel System](docs/en/channel/01-channel-system.md) | Remote Agent control via Telegram/Feishu/Discord IM platforms |
| [Computer Use](docs/en/features/computer-use.md) | Desktop control (screenshots, mouse, keyboard) — [Architecture](docs/en/features/computer-use-architecture.md) |
| [Desktop App](docs/desktop/) | Tauri 2 + React GUI client — [Quick Start](docs/desktop/01-quick-start.md) \| [Architecture](docs/desktop/02-architecture.md) \| [Installation](docs/desktop/04-installation.md) |
| [Global Usage](docs/en/guide/global-usage.md) | Run superai-agent from any directory |
| [FAQ](docs/en/guide/faq.md) | Common error troubleshooting |
| [Source Fixes](docs/en/reference/fixes.md) | Fixes compared with the original leaked source |
| [Project Structure](docs/en/reference/project-structure.md) | Code directory structure |

---

## Disclaimer

This project is provided for learning and research purposes only. Please comply with the terms of service of the API providers you use and applicable laws. Upstream Claude Code copyrights belong to [Anthropic](https://www.anthropic.com).
