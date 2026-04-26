/**
 * Convert an inbound `WeixinMessage.item_list` into a normalised
 * `{ text, pendingDownloads }` payload, mirroring the shape produced by
 * adapters/feishu/extract-payload.ts so the runtime side is platform-agnostic.
 *
 * WeChat ilink-bot lumps every modality into the same `item_list`, with
 * `type` distinguishing text/image/voice/file/video. Voice and video share
 * the file pipeline because Claude Code does not have a native audio path —
 * we surface them as files so the user at least sees the attachment.
 */

import type { WeixinMessage } from './client.js'
import { WX_ITEM_TYPE } from './client.js'

export type WechatPendingDownload = {
  kind: 'image' | 'file'
  filekey: string
  aeskey?: string
  cdnUrl?: string
  fileName?: string
  itemType: number
}

export interface InboundPayload {
  text: string
  pendingDownloads: WechatPendingDownload[]
}

export function extractInboundPayload(msg: WeixinMessage): InboundPayload {
  const items = msg.item_list ?? []
  const textParts: string[] = []
  const downloads: WechatPendingDownload[] = []

  for (const item of items) {
    switch (item.type) {
      case WX_ITEM_TYPE.TEXT: {
        const t = item.text_item?.text
        if (typeof t === 'string' && t.length > 0) textParts.push(t)
        break
      }
      case WX_ITEM_TYPE.IMAGE: {
        const f = item.image_item?.filekey
        if (typeof f === 'string' && f) {
          downloads.push({
            kind: 'image',
            filekey: f,
            aeskey: item.image_item?.aeskey,
            cdnUrl: item.image_item?.cdn_url,
            itemType: WX_ITEM_TYPE.IMAGE,
          })
        }
        break
      }
      case WX_ITEM_TYPE.FILE: {
        const f = item.file_item?.filekey
        if (typeof f === 'string' && f) {
          downloads.push({
            kind: 'file',
            filekey: f,
            aeskey: item.file_item?.aeskey,
            cdnUrl: item.file_item?.cdn_url,
            fileName: item.file_item?.filename,
            itemType: WX_ITEM_TYPE.FILE,
          })
        }
        break
      }
      case WX_ITEM_TYPE.VOICE: {
        const f = item.voice_item?.filekey
        if (typeof f === 'string' && f) {
          downloads.push({
            kind: 'file',
            filekey: f,
            aeskey: item.voice_item?.aeskey,
            cdnUrl: item.voice_item?.cdn_url,
            fileName: `voice-${f}.opus`,
            itemType: WX_ITEM_TYPE.VOICE,
          })
        }
        break
      }
      case WX_ITEM_TYPE.VIDEO: {
        const f = item.video_item?.filekey
        if (typeof f === 'string' && f) {
          downloads.push({
            kind: 'file',
            filekey: f,
            aeskey: item.video_item?.aeskey,
            cdnUrl: item.video_item?.cdn_url,
            fileName: `video-${f}.mp4`,
            itemType: WX_ITEM_TYPE.VIDEO,
          })
        }
        break
      }
      default:
        // Unknown item types are dropped silently — server may add new ones
        // (e.g. ref_msg, sysmsg) and the bot should not fail because of them.
        break
    }
  }

  return { text: textParts.join(''), pendingDownloads: downloads }
}
