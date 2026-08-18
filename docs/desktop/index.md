# SuperAI Agent 桌面端文档

> 一个面向办公与开发两类用户的本地 AI Agent 桌面应用：Work / Code 双模式、多会话多标签、任意 Anthropic 兼容模型、办公文档 agent、Computer Use、IM 远程接入。

![SuperAI Agent 桌面端](../images/desktop_ui/01_full_ui.png)

---

## 文档目录

### [快速上手](./01-quick-start.md)

面向用户：界面布局、Work / Code 模式、对话操作、多标签、权限控制、项目目录、模型与服务商、MCP 连接器、IM 接入、定时任务、Computer Use、应用更新、快捷键、主题与语言。

### [架构设计](./02-architecture.md)

面向开发者：三层架构（Tauri → Server Sidecar → CLI 子进程）、WebSocket 协议、HTTP API、状态管理、协议代理、适配器桥接、配置文件位置、目录结构。

### [功能详解](./03-features.md)

逐个模块：聊天引擎、代码展示、多标签、权限、Agent Teams、服务商管理、Work 模式角色与连接器、办公文档 agent、技能 / Agent、定时任务、IM 适配器、Computer Use、设计系统、应用更新。

### [安装指南](./04-installation.md)

Windows 便携版（推荐）、GitHub Release 安装包、macOS 说明、Web UI 模式、常见问题。

---

## 快速开始

### 用户

1. 按 [安装指南](./04-installation.md) 获取程序（Windows 直接解压便携版 zip）
2. 双击 `SuperAIAgent.exe`，在 **设置 → 服务商** 添加一个模型服务商（DeepSeek / 智谱 GLM / Kimi / MiniMax / 自定义 Anthropic 兼容地址，或 Claude / OpenAI 官方登录）
3. 左上角选择 **Work**（办公）或 **Code**（开发）模式，点击 **New session** 开始对话

同一目录下的 `superai.exe` 是同一套引擎的终端版本（`superai -c` 继续上次会话，`superai -r` 选择会话）。

### 开发者

1. 阅读 [架构设计](./02-architecture.md) 理解三层架构
2. 关键源码位置：
   - `desktop/src/` — React 前端（`components/layout` 外壳、`pages/Settings.tsx` 设置页、`stores/` 状态）
   - `desktop/src-tauri/` — Tauri 2 Rust 外壳（窗口、Sidecar 编排、自动更新）
   - `desktop/sidecars/` — Sidecar 入口（server / cli / adapters 三种模式）
   - `src/server/` — Bun HTTP/WebSocket 服务端与业务服务（会话、服务商、MCP、定时任务…）
   - `src/` 其余部分 — 终端 UI 与 Agent 内核（桌面端与 `superai.exe` 共用）
   - `adapters/` — 飞书 / Telegram / 微信 IM 适配器
   - `scripts/build-portable.ps1` — Windows 便携包打包

---

## 核心概念

| 概念 | 说明 |
|------|------|
| **Work / Code 模式** | 侧边栏品牌处的下拉开关。Work 面向办公用户（文档、表格、PPT、日程、邮件），Code 面向开发者；每个会话记录创建时的模式 |
| **Session** | 一次对话会话，绑定一个工作目录，通过 WebSocket 与服务端通信；同一目录可以有多个会话 |
| **Tab** | 标签页，对应一个 Session 或特殊页面（设置、定时任务） |
| **Provider（服务商）** | 模型来源：预设的 Anthropic 兼容服务商、自定义 Base URL + API Key、Claude 官方登录、OpenAI Codex 登录。配置保存在 `~/.claude/superai/`，桌面端与终端 UI 共用 |
| **Role（角色）** | Work 模式内置的职场角色（Assistant / Sales / Analyst / office），定义在 `~/.superai/` 下的可编辑文件中 |
| **Connector（连接器）** | MCP 设置页里一键接入的职场工具（飞书 / Lark、Microsoft 365 …），本质是普通 MCP 服务器 |
| **Adapter（IM 适配器）** | 通过飞书 / Telegram / 微信公众号远程驱动同一套 Agent |
| **Sidecar** | 随桌面端启动的后台进程：`superai-agent-sidecar server` 提供 API，`… adapters` 运行 IM 适配器 |
| **Store** | 前端 Zustand 状态容器，按领域拆分（session / tab / chat / provider / update …） |
