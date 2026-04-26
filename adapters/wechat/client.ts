/**
 * Low-level HTTP client for the ilink-bot WeChat API.
 *
 * Endpoint paths and request shapes mirror what the official Tencent
 * `@tencent-weixin/openclaw-weixin-cli` plugin speaks. References:
 *   - https://github.com/FFengIll/understand-tencent-weixin-openclaw-weixin
 *
 * All endpoints are kept as named constants at the top of the file so that
 * if Tencent ever ships a path change in a new plugin release, fixing it is
 * a one-line edit.
 *
 * This client deliberately does NOT depend on @tencent-weixin/openclaw-weixin-cli
 * — that package targets the OpenClaw runtime, not cc-haha. We re-implement
 * the wire protocol so the adapter integrates with Desktop Webapp's IM 接入
 * pairing flow (see adapters/README.md) just like Telegram and Feishu do.
 */

import { randomWechatUin } from './crypto.js'

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'

export const WX_ENDPOINTS = {
  qrcode: '/ilink/bot/getqrcode',
  qrstatus: '/ilink/bot/getqrcodestatus',
  getUpdates: '/ilink/bot/getupdates',
  sendMessage: '/ilink/bot/sendmessage',
  getUploadUrl: '/ilink/bot/getuploadurl',
  getConfig: '/ilink/bot/getconfig',
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

export interface QrCodeResponse {
  ret: number
  errcode?: number
  errmsg?: string
  qrcode?: string
  qrcode_img_content?: string
  expires_in?: number
}

export interface QrStatusResponse {
  ret: number
  errcode?: number
  errmsg?: string
  status?: 'wait' | 'scaned' | 'confirmed' | 'expired'
  bot_token?: string
  ilink_bot_id?: string
  ilink_user_id?: string
  baseurl?: string
}

export class WeixinClient {
  constructor(
    public baseUrl: string,
    public token?: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-WECHAT-UIN': randomWechatUin(),
    }
    if (this.token) {
      h['AuthorizationType'] = 'ilink_bot_token'
      h['Authorization'] = `Bearer ${this.token}`
    }
    return h
  }

  /** POST a JSON body and parse the JSON reply. Throws on transport
   *  failures and on non-2xx HTTP codes; protocol errors (errcode) are
   *  returned in the response object for the caller to inspect. */
  async post<T>(endpoint: string, body: unknown, timeoutMs = 15_000): Promise<T> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const resp = await fetch(this.baseUrl + endpoint, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body ?? {}),
        signal: ctrl.signal,
      })
      if (!resp.ok) {
        throw new Error(`[Wechat] ${endpoint} -> HTTP ${resp.status}`)
      }
      return (await resp.json()) as T
    } finally {
      clearTimeout(timer)
    }
  }

  async getQrCode(): Promise<QrCodeResponse> {
    return this.post<QrCodeResponse>(WX_ENDPOINTS.qrcode, {})
  }

  async getQrCodeStatus(qrcode: string): Promise<QrStatusResponse> {
    return this.post<QrStatusResponse>(WX_ENDPOINTS.qrstatus, { qrcode }, 40_000)
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
    return this.post(WX_ENDPOINTS.sendMessage, req)
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
