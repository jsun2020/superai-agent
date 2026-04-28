/**
 * WeChat media service.
 *
 * Inbound: download an encrypted blob from the CDN URL embedded in a
 * message item, decrypt it with the matching aeskey, and stage it on
 * disk via AttachmentStore so the rest of the pipeline (size limits,
 * AttachmentRef construction) is identical to telegram/feishu.
 *
 * Outbound: encrypt the buffer with a freshly-generated AES-128-ECB key,
 * register the (filekey, aeskey, sizes, md5) tuple via getuploadurl, PUT
 * the ciphertext to the returned CDN URL, then send a sendmessage call
 * referencing the filekey.
 */

import * as path from 'node:path'
import { AttachmentStore } from '../common/attachment/attachment-store.js'
import type { LocalAttachment } from '../common/attachment/attachment-types.js'
import { WX_ITEM_TYPE, type SendCdnMedia, type WeixinClient } from './client.js'
import {
  decryptAesEcb,
  encryptAesEcb,
  md5Hex,
  paddedSize,
  randomAesKey,
} from './crypto.js'

function guessImageMime(name: string): string {
  const ext = path.extname(name).toLowerCase().replace(/^\./, '')
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'heic':
      return 'image/heic'
    default:
      return 'image/png'
  }
}

function guessFileMime(name: string): string {
  const ext = path.extname(name).toLowerCase().replace(/^\./, '')
  switch (ext) {
    case 'pdf':
      return 'application/pdf'
    case 'doc':
      return 'application/msword'
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case 'xls':
      return 'application/vnd.ms-excel'
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case 'ppt':
      return 'application/vnd.ms-powerpoint'
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    case 'txt':
      return 'text/plain'
    case 'json':
      return 'application/json'
    case 'opus':
      return 'audio/opus'
    case 'mp4':
      return 'video/mp4'
    default:
      return 'application/octet-stream'
  }
}

export interface DownloadParams {
  filekey: string
  aeskey?: string
  cdnUrl?: string
  kind: 'image' | 'file'
  fileName?: string
  sessionId: string
}

export class WeixinMediaService {
  constructor(
    private readonly client: WeixinClient,
    private readonly store: AttachmentStore,
  ) {}

  /** Download → decrypt → stage on disk. Without a `cdnUrl` and `aeskey`
   *  pair we cannot reconstruct the original bytes; in that case we throw
   *  so the caller can surface a clear "📎 附件下载失败" hint. */
  async downloadResource(params: DownloadParams): Promise<LocalAttachment> {
    const { filekey, aeskey, cdnUrl, kind, sessionId } = params
    if (!cdnUrl) {
      throw new Error('[WechatMedia] missing cdn_url, cannot download')
    }
    if (!aeskey) {
      throw new Error('[WechatMedia] missing aeskey, cannot decrypt')
    }
    const fallback = `${filekey}${kind === 'image' ? '.png' : ''}`
    const name = params.fileName || fallback
    const target = this.store.resolvePath('wechat', sessionId, name)

    const ciphertext = await this.client.downloadFromCdn(cdnUrl)
    const key = Buffer.from(aeskey, 'base64')
    const plaintext = decryptAesEcb(ciphertext, key)
    await this.store.write(target, plaintext)

    return {
      kind,
      name,
      path: target,
      size: plaintext.length,
      mimeType: kind === 'image' ? guessImageMime(name) : guessFileMime(name),
      buffer: plaintext,
    }
  }

  /** Encrypt → register upload slot → PUT ciphertext → return the
   *  SendCdnMedia descriptor that goes inside the next sendmessage call.
   *
   *  Tencent v2.1.x reshaped this flow: getuploadurl now returns
   *  `{ upload_param, upload_full_url }`. The opaque `upload_param` token
   *  must be echoed back as `encrypt_query_param` in the SendItem so the
   *  recipient's CDN download URL stays valid. We fall back to the legacy
   *  v1.x `upload_url` field if that's what the server actually returned. */
  private async uploadEncrypted(
    plaintext: Buffer,
    mediaType: number,
  ): Promise<SendCdnMedia> {
    const key = randomAesKey()
    const ciphertext = encryptAesEcb(plaintext, key)
    const aeskeyB64 = key.toString('base64')
    const fingerprint = md5Hex(plaintext)
    const proposedKey = `cc-haha-${fingerprint}-${plaintext.length}`

    const slot = await this.client.getUploadUrl({
      filekey: proposedKey,
      media_type: mediaType,
      rawsize: plaintext.length,
      rawfilemd5: fingerprint,
      filesize: paddedSize(plaintext.length),
      aeskey: aeskeyB64,
    })
    // v1.x signalled failure via `ret !== 0`; v2.1.x leaves `ret` absent on
    // success. Treat absence-of-error as success and only abort when an
    // explicit non-zero ret OR an errcode is reported.
    if ((slot.ret != null && slot.ret !== 0) || slot.errcode) {
      throw new Error(
        `[WechatMedia] getUploadUrl failed: ret=${slot.ret} errcode=${slot.errcode} ${slot.errmsg ?? ''}`,
      )
    }
    const uploadUrl = slot.upload_full_url || slot.upload_url
    if (!uploadUrl) {
      throw new Error('[WechatMedia] getUploadUrl returned no upload URL')
    }
    await this.client.putToCdn(uploadUrl, ciphertext)

    return {
      encrypt_query_param: slot.upload_param ?? slot.filekey ?? proposedKey,
      aes_key: aeskeyB64,
      encrypt_type: 1,
      full_url: uploadUrl,
    }
  }

  /** Send an image to the WeChat user. The plaintext buffer is encrypted
   *  with a per-message AES-128-ECB key, uploaded to the CDN slot returned
   *  by getuploadurl, and the resulting media descriptor is wrapped in an
   *  `image_item` SendItem.
   *
   *  Throws on protocol error so the caller can apply its own fallback
   *  (e.g. send a text message with the file path instead). */
  async sendImageMessage(
    toUserId: string,
    plaintext: Buffer,
    contextToken?: string,
  ): Promise<void> {
    const media = await this.uploadEncrypted(plaintext, WX_ITEM_TYPE.IMAGE)
    const resp = await this.client.sendMessage({
      to_user_id: toUserId,
      context_token: contextToken,
      item_list: [
        {
          type: WX_ITEM_TYPE.IMAGE,
          image_item: { media, mid_size: paddedSize(plaintext.length) },
        },
      ],
    })
    if (resp.ret != null && resp.ret !== 0) {
      throw new Error(
        `[WechatMedia] sendMessage(image) ret=${resp.ret} errcode=${resp.errcode} ${resp.errmsg ?? ''}`,
      )
    }
  }

  async sendFileMessage(
    toUserId: string,
    plaintext: Buffer,
    fileName: string,
    contextToken?: string,
  ): Promise<void> {
    const media = await this.uploadEncrypted(plaintext, WX_ITEM_TYPE.FILE)
    const resp = await this.client.sendMessage({
      to_user_id: toUserId,
      context_token: contextToken,
      item_list: [
        {
          type: WX_ITEM_TYPE.FILE,
          file_item: { media, file_name: fileName, len: String(plaintext.length) },
        },
      ],
    })
    if (resp.ret != null && resp.ret !== 0) {
      throw new Error(
        `[WechatMedia] sendMessage(file) ret=${resp.ret} errcode=${resp.errcode} ${resp.errmsg ?? ''}`,
      )
    }
  }
}
