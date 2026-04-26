/**
 * Persistent state for WeChat ilink-bot accounts.
 *
 * Two files per account live under `~/.claude/wechat-accounts/`:
 *   - `<accountId>.json`       — long-lived credentials (token, baseUrl, ilinkBotId, ilinkUserId)
 *   - `<accountId>.sync.json`  — opaque get_updates_buf cursor for long-poll resume
 *
 * The split mirrors the OpenClaw plugin's layout (which used `~/.openclaw/...`)
 * so anyone migrating credentials by hand has a 1:1 file mapping.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

export type WeixinAccount = {
  accountId: string
  baseUrl: string
  token: string
  ilinkBotId?: string
  ilinkUserId?: string
  createdAt: number
}

function getAccountsDir(): string {
  const root = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(root, 'wechat-accounts')
}

function ensureDir(): string {
  const dir = getAccountsDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function accountPath(id: string): string {
  return path.join(ensureDir(), `${id}.json`)
}

function syncPath(id: string): string {
  return path.join(ensureDir(), `${id}.sync.json`)
}

export function saveAccount(account: WeixinAccount): void {
  const target = accountPath(account.accountId)
  const tmp = `${target}.tmp.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(account, null, 2) + '\n', 'utf-8')
  fs.renameSync(tmp, target)
}

export function loadAccount(accountId: string): WeixinAccount | null {
  try {
    const raw = fs.readFileSync(accountPath(accountId), 'utf-8')
    return JSON.parse(raw) as WeixinAccount
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null
    throw err
  }
}

export function listAccounts(): WeixinAccount[] {
  const dir = ensureDir()
  const out: WeixinAccount[] = []
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json') || name.endsWith('.sync.json')) continue
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')))
    } catch {
      // Skip corrupt entries — we don't want a bad file to take the bot offline.
    }
  }
  return out
}

export function loadSyncCursor(accountId: string): string {
  try {
    const raw = fs.readFileSync(syncPath(accountId), 'utf-8')
    const parsed = JSON.parse(raw)
    return typeof parsed.get_updates_buf === 'string' ? parsed.get_updates_buf : ''
  } catch {
    return ''
  }
}

export function saveSyncCursor(accountId: string, cursor: string): void {
  const target = syncPath(accountId)
  const tmp = `${target}.tmp.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify({ get_updates_buf: cursor }, null, 2) + '\n', 'utf-8')
  fs.renameSync(tmp, target)
}
