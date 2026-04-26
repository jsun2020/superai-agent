/**
 * One-shot login script for a WeChat ilink-bot account.
 *
 * Flow:
 *   1. Call getQrCode → save the returned PNG to ~/.claude/wechat-qr.png
 *   2. Print the path so the user can open and scan it on a phone
 *   3. Poll getQrCodeStatus until status === 'confirmed' or 'expired'
 *   4. Persist {token, baseUrl, ilinkBotId, ilinkUserId} to
 *      ~/.claude/wechat-accounts/<ilinkBotId>.json
 *
 * Usage:
 *   bun run wechat:login
 *   # or, against a custom base URL:
 *   WECHAT_BASE_URL=https://ilinkai.weixin.qq.com bun run wechat:login
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { WeixinClient, DEFAULT_BASE_URL } from './client.js'
import { saveAccount } from './account-store.js'

const POLL_INTERVAL_MS = 2_000
const POLL_TIMEOUT_MS = 5 * 60 * 1000

function qrPath(): string {
  const home = os.homedir()
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'wechat-qr.png')
}

function decodeQrPayload(raw: string): Buffer {
  // Some servers include a `data:image/png;base64,` prefix, others return
  // the raw base64 only. Normalise both forms.
  const stripped = raw.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
  return Buffer.from(stripped, 'base64')
}

async function main(): Promise<void> {
  const baseUrl = process.env.WECHAT_BASE_URL || DEFAULT_BASE_URL
  console.log(`[Wechat-Login] Using base URL: ${baseUrl}`)

  const client = new WeixinClient(baseUrl)
  const qr = await client.getQrCode()
  if (qr.ret !== 0 || !qr.qrcode || !qr.qrcode_img_content) {
    console.error('[Wechat-Login] getQrCode failed:', qr)
    process.exit(1)
  }

  const target = qrPath()
  fs.writeFileSync(target, decodeQrPayload(qr.qrcode_img_content))
  console.log(`[Wechat-Login] QR code saved to: ${target}`)
  console.log('[Wechat-Login] Open the file and scan it with your WeChat app, then confirm on the phone.')

  const deadline = Date.now() + POLL_TIMEOUT_MS
  let lastStatus = ''
  while (Date.now() < deadline) {
    const status = await client.getQrCodeStatus(qr.qrcode)
    if (status.ret !== 0) {
      console.error('[Wechat-Login] getQrCodeStatus error:', status)
      process.exit(1)
    }
    if (status.status && status.status !== lastStatus) {
      console.log(`[Wechat-Login] Status: ${status.status}`)
      lastStatus = status.status
    }
    if (status.status === 'expired') {
      console.error('[Wechat-Login] QR code expired before confirmation. Re-run the script.')
      process.exit(1)
    }
    if (status.status === 'confirmed') {
      if (!status.bot_token || !status.ilink_bot_id) {
        console.error('[Wechat-Login] Confirmation missing bot_token / ilink_bot_id:', status)
        process.exit(1)
      }
      const account = {
        accountId: status.ilink_bot_id,
        baseUrl: status.baseurl || baseUrl,
        token: status.bot_token,
        ilinkBotId: status.ilink_bot_id,
        ilinkUserId: status.ilink_user_id,
        createdAt: Date.now(),
      }
      saveAccount(account)
      console.log(`[Wechat-Login] Saved account ${status.ilink_bot_id}`)
      console.log('[Wechat-Login] Done. Now run: bun run wechat')
      return
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }

  console.error('[Wechat-Login] Timed out waiting for confirmation.')
  process.exit(1)
}

main().catch((err) => {
  console.error('[Wechat-Login] Fatal:', err)
  process.exit(1)
})
