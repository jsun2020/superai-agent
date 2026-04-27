/**
 * Low-level HTTP client for the ilink-bot WeChat API.
 *
 * Endpoint paths, headers, and request shapes mirror what the official
 * Tencent `@tencent-weixin/openclaw-weixin@2.1.x` plugin sends on the wire.
 * The published source under `src/api/api.ts` and `src/auth/login-qr.ts`
 * (downloaded from npm) was used as the canonical reference.
 *
 * All endpoint paths are kept as named constants at the top of the file so
 * that if Tencent ever ships a path change in a new plugin release, fixing it
 * is a one-line edit.
 *
 * This client deliberately does NOT depend on @tencent-weixin/openclaw-weixin
 * — that package targets the OpenClaw runtime, not cc-haha. We re-implement
 * the wire protocol so the adapter integrates with Desktop Webapp's IM 接入
 * pairing flow (see adapters/README.md) just like Telegram and Feishu do.
 */

import { randomWechatUin } from './crypto.js'

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'

/** iLink-App-Id sent in every request. The upstream package.json sets this
 *  to "bot" and the server gates on it — without the header we get HTTP 404
 *  on QR endpoints (verified against ilinkai.weixin.qq.com on 2026-04-27). */
export const ILINK_APP_ID = 'bot'

/** Channel version reported in headers + body.base_info. We mirror the
 *  upstream plugin's released version so the server treats us as a known
 *  client; the value itself doesn't gate access today, but tracking the
 *  upstream avoids drift if Tencent ever min-version checks. */
export const CHANNEL_VERSION = '2.1.10'

/** iLink-App-ClientVersion: uint32 encoded as 0x00MMNNPP from semver.
 *  e.g. "2.1.10" -> (2<<16) | (1<<8) | 10 = 131338. */
function encodeClientVersion(version: string): number {
  const parts = version.split('.').map((p) => parseInt(p, 10))
  const [major = 0, minor = 0, patch = 0] = parts
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

export const ILINK_APP_CLIENT_VERSION = encodeClientVersion(CHANNEL_VERSION)

/** Default `bot_type` query parameter for get_bot_qrcode / get_qrcode_status. */
export const DEFAULT_BOT_TYPE = '3'

export const WX_ENDPOINTS = {
  // GET endpoints (query-parameter based, no body)
  qrcode: 'ilink/bot/get_bot_qrcode',
  qrstatus: 'ilink/bot/get_qrcode_status',
  // POST endpoints (JSON body with base_info)
  getUpdates: 'ilink/bot/getupdates',
  sendMessage: 'ilink/bot/sendmessage',
  sendTyping: 'ilink/bot/sendtyping',
  getUploadUrl: 'ilink/bot/getuploadurl',
  getConfig: 'ilink/bot/getconfig',
  notifyStop: 'ilink/bot/msg/notifystop',
  notifyStart: 'ilink/bot/msg/notifystart',
} as const

export const WX_ITEM_TYPE = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const

export const WX_ERR_TOKEN_EXPIRED = -14
export const TOKEN_EXPIRED_PAUSE_MS = 30 * 60 * 1000 // 30 min, matches OpenClaw plugin

export type SendItem =
  | { type: 1; text_item: { text: string } }
  | { type: 2; image_item: { filekey: string; aeskey: string } }
  | { type: 4; file_item: { filekey: string; aeskey?: string; filename?: string } }
  | { type: 5; video_item: { filekey: string; thumbkey?: string; aeskey?: string } }

export interface BaseInfo {
  channel_version: string
}

export interface SendMessageRequest {
  to_user_id: string
  context_token?: string
  item_list: SendItem[]
}

export interface UpdatesResponse {
  ret: number
  errcode?: number
  errmsg?: string
  get_updates_buf?: string
  msgs?: WeixinMessage[]
  longpolling_timeout_ms?: number
}

export interface WeixinMessage {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  create_time_ms?: number
  session_id?: string
  message_type?: number
  message_state?: number
  context_token?: string
  item_list?: WeixinMessageItem[]
}

export interface WeixinMessageItem {
  type?: number
  text_item?: { text?: string }
  image_item?: { filekey?: string; aeskey?: string; cdn_url?: string }
  voice_item?: { filekey?: string; aeskey?: string; cdn_url?: string }
  file_item?: { filekey?: string; aeskey?: string; filename?: string; cdn_url?: string }
  video_item?: { filekey?: string; aeskey?: string; thumbkey?: string; cdn_url?: string }
}

export interface UploadUrlResponse {
  ret: number
  errcode?: number
  errmsg?: string
  upload_url?: string
  filekey?: string
  upload_method?: 'PUT' | 'POST'
}

/** Response from get_bot_qrcode. The upstream plugin does NOT report a `ret`
 *  field on this endpoint — success is implied by HTTP 200 + presence of
 *  qrcode_img_content. The img_content is a URL/text payload that the client
 *  is expected to QR-encode locally; scanning the resulting QR with WeChat
 *  drives the auth flow. */
export interface QrCodeResponse {
  qrcode?: string
  qrcode_img_content?: string
  /** Only present on protocol-level errors. */
  errcode?: number
  errmsg?: string
}

/** Response from get_qrcode_status long-poll. */
export interface QrStatusResponse {
  status?: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect'
  bot_token?: string
  ilink_bot_id?: string
  ilink_user_id?: string
  baseurl?: string
  /** New host to redirect polling to when status === 'scaned_but_redirect'. */
  redirect_host?: string
  errcode?: number
  errmsg?: string
}

export class WeixinClient {
  constructor(
    public baseUrl: string,
    public token?: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  /** Headers shared by every request (GET + POST). */
  private commonHeaders(): Record<string, string> {
    return {
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
    }
  }

  /** Headers for POST requests — adds Content-Type, X-WECHAT-UIN, and the
   *  Bearer token when authenticated. */
  private postHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      ...this.commonHeaders(),
      'Content-Type': 'application/json',
      'X-WECHAT-UIN': randomWechatUin(),
    }
    if (this.token) {
      h['AuthorizationType'] = 'ilink_bot_token'
      h['Authorization'] = `Bearer ${this.token}`
    }
    return h
  }

  private joinUrl(endpoint: string): string {
    // Endpoints in WX_ENDPOINTS are stored without leading slash so URL()
    // can resolve them relative to baseUrl + '/'.
    return `${this.baseUrl}/${endpoint.replace(/^\/+/, '')}`
  }

  /** GET request returning the parsed JSON body. Used for the QR-code login
   *  endpoints which are query-parameter based and have no JSON request
   *  body. */
  async get<T>(endpoint: string, query: Record<string, string> = {}, timeoutMs = 40_000): Promise<T> {
    const url = new URL(this.joinUrl(endpoint))
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const resp = await fetch(url.toString(), {
        method: 'GET',
        headers: this.commonHeaders(),
        signal: ctrl.signal,
      })
      const text = await resp.text()
      if (!resp.ok) {
        throw new Error(`[Wechat] ${endpoint} -> HTTP ${resp.status}: ${text.slice(0, 200)}`)
      }
      return JSON.parse(text) as T
    } finally {
      clearTimeout(timer)
    }
  }

  /** POST a JSON body and parse the JSON reply. The body is auto-wrapped
   *  with `base_info` (channel_version) which the server expects on every
   *  authenticated POST. */
  async post<T>(endpoint: string, body: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    const wrappedBody = { ...body, base_info: { channel_version: CHANNEL_VERSION } as BaseInfo }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const resp = await fetch(this.joinUrl(endpoint), {
        method: 'POST',
        headers: this.postHeaders(),
        body: JSON.stringify(wrappedBody),
        signal: ctrl.signal,
      })
      const text = await resp.text()
      if (!resp.ok) {
        throw new Error(`[Wechat] ${endpoint} -> HTTP ${resp.status}: ${text.slice(0, 200)}`)
      }
      return JSON.parse(text) as T
    } finally {
      clearTimeout(timer)
    }
  }

  async getQrCode(botType: string = DEFAULT_BOT_TYPE): Promise<QrCodeResponse> {
    return this.get<QrCodeResponse>(WX_ENDPOINTS.qrcode, { bot_type: botType })
  }

  async getQrCodeStatus(qrcode: string): Promise<QrStatusResponse> {
    // The status endpoint is long-poll: server holds the connection up to
    // ~35s before returning. Give the client a slightly bigger budget so
    // we don't abort first.
    return this.get<QrStatusResponse>(WX_ENDPOINTS.qrstatus, { qrcode }, 40_000)
  }

  /** Long-poll for new messages. The server uses `get_updates_buf` as an
   *  opaque cursor — pass the previous response's value back unchanged. */
  async getUpdates(cursor: string, timeoutMs: number): Promise<UpdatesResponse> {
    return this.post<UpdatesResponse>(
      WX_ENDPOINTS.getUpdates,
      { get_updates_buf: cursor, timeoutMs },
      timeoutMs + 5_000,
    )
  }

  async sendMessage(req: SendMessageRequest): Promise<{ ret: number; errcode?: number; errmsg?: string }> {
    return this.post(WX_ENDPOINTS.sendMessage, req as unknown as Record<string, unknown>)
  }

  async getUploadUrl(params: {
    filekey: string
    media_type: number
    rawsize: number
    rawfilemd5: string
    filesize: number
    aeskey: string
  }): Promise<UploadUrlResponse> {
    return this.post<UploadUrlResponse>(WX_ENDPOINTS.getUploadUrl, params)
  }

  /** Raw byte upload to the CDN URL returned by getUploadUrl. The body is
   *  AES-128-ECB ciphertext; the server will decrypt with the aeskey we
   *  registered in getUploadUrl. */
  async putToCdn(uploadUrl: string, ciphertext: Buffer, timeoutMs = 60_000): Promise<void> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const resp = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: ciphertext,
        signal: ctrl.signal,
      })
      if (!resp.ok) {
        throw new Error(`[Wechat] CDN PUT -> HTTP ${resp.status}`)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Download an encrypted media blob from the CDN URL embedded in an
   *  inbound message item. The caller is responsible for decrypting with
   *  the matching aeskey. */
  async downloadFromCdn(cdnUrl: string, timeoutMs = 60_000): Promise<Buffer> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const resp = await fetch(cdnUrl, { signal: ctrl.signal })
      if (!resp.ok) {
        throw new Error(`[Wechat] CDN GET -> HTTP ${resp.status}`)
      }
      return Buffer.from(await resp.arrayBuffer())
    } finally {
      clearTimeout(timer)
    }
  }
}
