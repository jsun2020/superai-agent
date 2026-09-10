# SuperAI Agent in Chrome

A Chrome extension (Manifest V3) that puts SuperAI Agent in the browser's side panel and hands it the page's debugging state with every message: recent console errors and warnings, failed or erroring network requests, the element you right-clicked, and an optional screenshot.

It is a thin client of the **SuperAI Agent desktop app's local server** (`http://127.0.0.1:3456`). Sessions, streaming, tools, permissions and providers are the desktop's — the extension adds capture and a panel, nothing else runs in the browser.

## Build

```
cd chrome-extension
bun install
bun run build        # -> dist/
bun test             # pure modules: context formatting, transcript reducer
bun run typecheck
```

## Install (developer mode)

1. Start the SuperAI Agent desktop app (it runs the local server).
2. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → choose `chrome-extension/dist`.
3. Click the extension's toolbar icon to open the side panel (Chrome 116+).

## Use

- Type a question about the page you are on. With **Attach page context** on, the panel prepends a `<page-debug-context>` block: URL, title, the most recent console errors/warnings, failed requests (HTTP 4xx/5xx and network errors), and the selected element.
- Right-click anything on a page → **Ask SuperAI Agent about this element** — the element's CSS path and trimmed HTML attach to your next message.
- 📷 attaches a screenshot of the visible tab as an image; 🧹 clears what was captured for this tab.
- Set a **Project folder** in ⚙ so the agent can read and edit the site's source; the agent will ask before editing (Allow / Deny in the panel).
- Buffers are per tab, bounded (200 console entries, 100 network entries) and cleared when the tab navigates.

## Privacy

Capture stays inside the browser. Nothing is sent anywhere until you press **Send**, and then only to the local server address in settings, as part of your own message. The context block is visible in the transcript summary of each message.

## Not in this version

The agent cannot yet act on the page (navigate, click, pull fresh logs mid-turn). That is the planned v0.2.36: browser tools exposed to the session over MCP and executed by this extension.
