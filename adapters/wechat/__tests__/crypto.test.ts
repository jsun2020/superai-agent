import { describe, expect, test } from 'bun:test'
import {
  decryptAesEcb,
  encryptAesEcb,
  md5Hex,
  paddedSize,
  randomAesKey,
  randomWechatUin,
} from '../crypto.js'

describe('wechat/crypto', () => {
  test('round-trips a plaintext through AES-128-ECB', () => {
    const key = randomAesKey()
    const plaintext = Buffer.from('hello WeChat ilink-bot 你好', 'utf-8')
    const ciphertext = encryptAesEcb(plaintext, key)
    const decoded = decryptAesEcb(ciphertext, key)
    expect(decoded.equals(plaintext)).toBe(true)
  })

  test('rejects keys that are not 16 bytes', () => {
    expect(() => encryptAesEcb(Buffer.alloc(0), Buffer.alloc(8))).toThrow()
    expect(() => decryptAesEcb(Buffer.alloc(16), Buffer.alloc(24))).toThrow()
  })

  test('paddedSize matches PKCS#7 expansion to next 16-byte multiple', () => {
    expect(paddedSize(0)).toBe(16)
    expect(paddedSize(1)).toBe(16)
    expect(paddedSize(15)).toBe(16)
    expect(paddedSize(16)).toBe(32)
    expect(paddedSize(17)).toBe(32)
    expect(paddedSize(31)).toBe(32)
    expect(paddedSize(32)).toBe(48)
  })

  test('md5Hex is 32 lowercase hex characters', () => {
    const hash = md5Hex(Buffer.from('abc'))
    expect(hash).toBe('900150983cd24fb0d6963f7d28e17f72')
  })

  test('randomWechatUin returns valid base64 of 4 bytes', () => {
    const uin = randomWechatUin()
    const decoded = Buffer.from(uin, 'base64')
    expect(decoded.length).toBe(4)
  })
})
