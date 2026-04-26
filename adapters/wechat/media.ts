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
import { WX_ITEM_TYPE, type WeixinClient, type SendItem } from './client.js'
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

  /** Encrypt → register upload slot → PUT ciphertext → return references
   *  the caller can drop into a sendmessage `image_item`/`file_item`. */
  private async uploadEncrypted(
    plaintext: Buffer,
    mediaType: number,
  ): Promise<{ filekey: string; aeskey: string }> {
    const key = randomAesKey()
    const ciphertext = encryptAesEcb(plaintext, key)
    const aeskeyB64 = key.toString('base64')
    // Pre-shared filekey: server expects md5(plaintext) + length, but the
    // spec leaves the exact format opaque to clients. Sending the md5 is
    // the convention the OpenClaw plugin uses and is what we observed.
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
    if (slot.ret !== 0 || !slot.upload_url) {
      throw new Error(
        `[WechatMedia] getUploadUrl failed: ret=${slot.ret} errcode=${slot.errcode} ${slot.errmsg ?? ''}`,
      )
    }
    await this.client.putToCdn(slot.upload_url, ciphertext)

    return {
      filekey: slot.filekey || proposedKey,
      aeskey: aeskeyB64,
    }
  }

  async sendImageMessage(
    toUserId: string,
    plaintext: Buffer,
    contextToken?: string,
  ): Promise<void> {
    const { filekey, aeskey } = await this.uploadEncrypted(plaintext, WX_ITEM_TYPE.IMAGE)
    const item: SendItem = { type: WX_ITEM_TYPE.IMAGE, image_item: { filekey, aeskey } }
    const resp = await this.client.sendMessage({
      to_user_id: toUserId,
      context_token: contextToken,
      item_list: [item],
    })
    if (resp.ret !== 0) {
      throw new Error(
        `[WechatMedia] sendImage failed: ret=${resp.ret} errcode=${resp.errcode} ${resp.errmsg ?? ''}`,
      )
    }
  }

  async sendFileMessage(
    toUserId: string,
    plaintext: Buffer,
    fileName: string,
    contextToken?: string,
  ): Promise<void> {
    const { filekey, aeskey } = await this.uploadEncrypted(plaintext, WX_ITEM_TYPE.FILE)
    const item: SendItem = {
      type: WX_ITEM_TYPE.FILE,
      file_item: { filekey, aeskey, filename: fileName },
    }
    const resp = await this.client.sendMessage({
      to_user_id: toUserId,
      context_token: contextToken,
      item_list: [item],
    })
    if (resp.ret !== 0) {
      throw new Error(
        `[WechatMedia] sendFile failed: ret=${resp.ret} errcode=${resp.errcode} ${resp.errmsg ?? ''}`,
      )
    }
  }
}
