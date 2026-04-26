import { describe, expect, test } from 'bun:test'
import { extractInboundPayload } from '../extract-payload.js'
import { WX_ITEM_TYPE, type WeixinMessage } from '../client.js'

describe('wechat/extract-payload', () => {
  test('extracts plain text from a TEXT item', () => {
    const msg: WeixinMessage = {
      from_user_id: 'u1',
      item_list: [{ type: WX_ITEM_TYPE.TEXT, text_item: { text: 'hello' } }],
    }
    expect(extractInboundPayload(msg)).toEqual({ text: 'hello', pendingDownloads: [] })
  })

  test('concatenates multiple text items in order', () => {
    const msg: WeixinMessage = {
      item_list: [
        { type: WX_ITEM_TYPE.TEXT, text_item: { text: 'foo ' } },
        { type: WX_ITEM_TYPE.TEXT, text_item: { text: 'bar' } },
      ],
    }
    expect(extractInboundPayload(msg).text).toBe('foo bar')
  })

  test('lifts an IMAGE item into pendingDownloads with cdnUrl + aeskey passed through', () => {
    const msg: WeixinMessage = {
      item_list: [
        {
          type: WX_ITEM_TYPE.IMAGE,
          image_item: { filekey: 'fk-1', aeskey: 'YWVz', cdn_url: 'https://cdn/x' },
        },
      ],
    }
    const result = extractInboundPayload(msg)
    expect(result.text).toBe('')
    expect(result.pendingDownloads).toEqual([
      {
        kind: 'image',
        filekey: 'fk-1',
        aeskey: 'YWVz',
        cdnUrl: 'https://cdn/x',
        itemType: WX_ITEM_TYPE.IMAGE,
      },
    ])
  })

  test('voice and video become file downloads with synthetic filenames', () => {
    const msg: WeixinMessage = {
      item_list: [
        { type: WX_ITEM_TYPE.VOICE, voice_item: { filekey: 'v1' } },
        { type: WX_ITEM_TYPE.VIDEO, video_item: { filekey: 'vid1' } },
      ],
    }
    const result = extractInboundPayload(msg)
    expect(result.pendingDownloads.map((d) => d.fileName)).toEqual([
      'voice-v1.opus',
      'video-vid1.mp4',
    ])
    expect(result.pendingDownloads.map((d) => d.kind)).toEqual(['file', 'file'])
  })

  test('ignores items with unknown types instead of throwing', () => {
    const msg: WeixinMessage = {
      item_list: [
        { type: 999 as unknown as number },
        { type: WX_ITEM_TYPE.TEXT, text_item: { text: 'kept' } },
      ],
    }
    expect(extractInboundPayload(msg).text).toBe('kept')
  })
})
