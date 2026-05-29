# OpenAI Codex Integration

SuperAI Agent ships **OpenAI Codex** as a first-class provider. Sessions drive the locally installed `codex` CLI and reuse your ChatGPT login — **no `OPENAI_API_KEY` required**.

When to use it:
- You already pay for ChatGPT Plus / Pro / Team and want to skip the extra API bill.
- You don't want to manage or rotate an OpenAI API key.
- You want to use Anthropic and Codex side-by-side from the same desktop client.

---

## 1. Install the Codex CLI

With Node.js 18+ installed:

```bash
npm install -g @openai/codex
```

Verify:

```bash
codex --version
```

> The desktop client looks for the `codex` binary in this order:
> 1. The `CODEX_CLI_PATH` env var
> 2. `codex` on `PATH`
> 3. `~/.npm-global/bin/codex`
> 4. `~/.bun/bin/codex`
> 5. `/opt/homebrew/bin/codex`, `/usr/local/bin/codex`
>
> If your install lives somewhere else, set `CODEX_CLI_PATH` to the absolute path.

---

## 2. Sign in to ChatGPT

In the SuperAI Agent desktop app:

1. Open **Settings → Codex Official Login**.
2. Click **"Sign in to Codex"**.
3. The built-in terminal runs:
   ```
   codex logout
   codex login
   ```
4. Follow the prompts in your browser to complete the OAuth handshake.

The login state lives in `~/.codex/auth.json` and is refreshed by the Codex CLI itself. SuperAI Agent never reads or writes those tokens.

> **Why `codex logout` first?** ChatGPT OAuth rotates the refresh token on every successful login, and a new device's login revokes the old device's refresh token. Logging out first guarantees you start each round from a clean state and avoids collisions with stale, already-revoked tokens.

---

## 3. Use Codex in a session

When creating a session, pick the **Codex** runtime (or a Codex model like `gpt-5-codex`). The session UX matches the Anthropic flow:

- Tool calls, permission prompts, file diffs all use the same desktop UI.
- Permission-mode mapping:
  - `bypassPermissions` → `codex exec --dangerously-bypass-approvals-and-sandbox`
  - `plan` → `codex exec -a never -s read-only`
  - default / acceptEdits → `codex exec -a never -s workspace-write`

The model is read from the `model` field in `~/.claude/superai/settings.json`; if it is not set, the built-in default `OPENAI_CODEX_DEFAULT_MODEL_ID` is used.

---

## 4. Troubleshooting (Windows)

| Symptom | Cause | Fix |
|---------|-------|-----|
| `codex` not found / ENOENT | The npm-global `.cmd` shim is not on PATH | Reopen the shell, or add `%APPDATA%\npm` to PATH; or set `CODEX_CLI_PATH` to the absolute path |
| Hangs at `Reading additional input from stdin...` | Older builds left stdin inherited through the `.cmd` shim. v0.2.2 closes stdin immediately after spawn | Upgrade to v0.2.2+ |
| `codex-windows-sandbox-setup.exe` still running after stop | On Windows `proc.kill()` does not propagate to children. v0.2.2 uses `taskkill /F /T /PID` to kill the whole tree | Upgrade to v0.2.2+; clean leftovers with `Get-Process codex*` + `Stop-Process` |
| Repeated logins return `token_invalidated` / `refresh_token_invalidated` | Multiple devices are revoking each other's refresh tokens | Run **Settings → Sign in to Codex** once to do a full logout + login cycle |
| Desktop cannot reach the sidecar, but browser can | Corporate proxy is intercepting `127.0.0.1` | v0.2.2+ injects `NO_PROXY=loopback` into the sidecar. On older versions, add `localhost,127.0.0.1` to your system NO_PROXY |

---

## 5. Related code

- `src/server/services/conversationService.ts` — `runtime: 'codex'` branch, `resolveCodexCommand`, `buildCodexExecArgs`, `resolveCodexModel`, `shouldUseTaskkill`
- `desktop/src/components/settings/CodexOfficialLogin.tsx` — the desktop sign-in card
- `src/server/__tests__/codex-timeout.test.ts` — unit tests for timeout resolution and the Windows process-tree helper
