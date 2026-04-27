/**
 * One-shot login script for a WeChat ilink-bot account.
 *
 * Flow (matches @tencent-weixin/openclaw-weixin@2.1.x):
 *   1. GET /ilink/bot/get_bot_qrcode?bot_type=3
 *      -> { qrcode, qrcode_img_content }   (img_content is a URL/text, NOT a PNG)
 *   2. Encode qrcode_img_content as a QR PNG locally (via the `qrcode` npm
 *      package) and save to ~/.claude/wechat-qr.png; also print the URL so
 *      the user can paste it into a browser if the PNG fails to render.
 *      Print an ASCII QR via `qrcode` to the terminal for headless use.
 *   3. Long-poll get_qrcode_status until status === 'confirmed'. Handle:
 *        - 'wait'                 → keep polling
 *        - 'scaned'               → just log, keep polling
 *        - 'scaned_but_redirect'  → switch baseUrl to redirect_host and keep polling
 *        - 'expired'              → tell user to re-run, exit 1
 *        - 'confirmed'            → save account, exit 0
 *   4. Persist {token, baseUrl, ilinkBotId, ilinkUserId} to
 *      ~/.claude/wechat-accounts/<ilinkBotId>.json
 *
 * Usage:
 *   bun run wechat:login
 *   # custom base URL:
 *   WECHAT_BASE_URL=https://ilinkai.weixin.qq.com bun run wechat:login
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import QRCode from 'qrcode'
import { WeixinClient, DEFAULT_BASE_URL } from './client.js'
import { saveAccount } from './account-store.js'

const POLL_INTERVAL_MS = 1_000
const POLL_TIMEOUT_MS = 8 * 60 * 1000

function configDir(): string {
  const home = os.homedir()
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function qrPngPath(): string {
  return path.join(configDir(), 'wechat-qr.png')
}

async function main(): Promise<void> {
  const baseUrl = process.env.WECHAT_BASE_URL || DEFAULT_BASE_URL
  console.log(`[Wechat-Login] Using base URL: ${baseUrl}`)

  let client = new WeixinClient(baseUrl)
  const qr = await client.getQrCode()
  if (!qr.qrcode || !qr.qrcode_img_content) {
    console.error('[Wechat-Login] getQrCode returned no qrcode payload:', qr)
    process.exit(1)
  }

  // qrcode_img_content is a URL/text payload — encode it as a QR PNG locally
  // and dump an ASCII QR to stdout. Scanning the QR with WeChat starts the
  // login flow on the phone.
  const png = qrPngPath()
  await QRCode.toFile(png, qr.qrcode_img_content, { width: 480, margin: 2 })
  console.log(`[Wechat-Login] QR PNG saved to: ${png}`)
  console.log('[Wechat-Login] Open the PNG and scan it with WeChat, or open the URL below in a browser:')
  console.log(`[Wechat-Login]   ${qr.qrcode_img_content}`)
  console.log('')

  try {
    const ascii = await QRCode.toString(qr.qrcode_img_content, { type: 'terminal', small: true })
    console.log(ascii)
  } catch {
    // qrcode-terminal-style ASCII can fail in some terminals — the PNG +
    // URL above are the always-available fallback.
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS
  let lastStatus = ''
  let currentBaseUrl = baseUrl
  while (Date.now() < deadline) {
    let status
    try {
      status = await client.getQrCodeStatus(qr.qrcode)
    } catch (err) {
      // Long-poll timeouts and gateway hiccups (Cloudflare 524 etc.) are
      // expected — retry rather than abort. Tencent's own client does the
      // same: see plugin src/auth/login-qr.ts pollQRStatus.
      console.warn(`[Wechat-Login] poll error (will retry): ${String(err)}`)
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      continue
    }

    if (status.status && status.status !== lastStatus) {
      console.log(`[Wechat-Login] Status: ${status.status}`)
      lastStatus = status.status
    }

    switch (status.status) {
      case 'expired':
        console.error('[Wechat-Login] QR code expired before confirmation. Re-run the script.')
        process.exit(1)

      case 'scaned_but_redirect': {
        // Server is asking us to migrate to a different IDC host. Switch the
        // client and keep polling; the original qrcode token is still valid.
        if (status.redirect_host) {
          currentBaseUrl = `https://${status.redirect_host}`
          console.log(`[Wechat-Login] Server redirect: switching to ${currentBaseUrl}`)
          client = new WeixinClient(currentBaseUrl)
        }
        break
      }

      case 'confirmed': {
        if (!status.bot_token || !status.ilink_bot_id) {
          console.error('[Wechat-Login] Confirmation missing bot_token / ilink_bot_id:', status)
          process.exit(1)
        }
        const account = {
          accountId: status.ilink_bot_id,
          baseUrl: status.baseurl || currentBaseUrl,
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

      // 'wait' / 'scaned' / undefined → just keep polling
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
