/**
 * WeChat ilink-bot media encryption.
 *
 * The WeChat side enforces AES-128-ECB on every CDN-uploaded media object:
 *   - 16-byte AES key, freshly randomly generated per file
 *   - PKCS#7 padding to 16-byte block boundary
 *   - The key is base64-encoded into the message envelope as `aeskey`
 *     so the receiver can decrypt the bytes downloaded from the CDN.
 *
 * This module is the only place that knows the cipher details.
 */

import * as crypto from 'node:crypto'

export function randomAesKey(): Buffer {
  return crypto.randomBytes(16)
}

export function md5Hex(buffer: Buffer): string {
  return crypto.createHash('md5').update(buffer).digest('hex')
}

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== 16) {
    throw new Error(`[wechat-crypto] AES-128 key must be 16 bytes, got ${key.length}`)
  }
  // Node's createCipheriv requires a non-null IV value for some modes; ECB takes null.
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null)
  cipher.setAutoPadding(true)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  if (key.length !== 16) {
    throw new Error(`[wechat-crypto] AES-128 key must be 16 bytes, got ${key.length}`)
  }
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null)
  decipher.setAutoPadding(true)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** Predict the encrypted (PKCS#7-padded) byte length for a plaintext of `size`.
 *  WeChat's getuploadurl endpoint requires both raw and ciphertext sizes
 *  before the upload happens, so we compute it without actually encrypting. */
export function paddedSize(size: number): number {
  return Math.ceil((size + 1) / 16) * 16
}

/** Random 32-bit unsigned int, base64-encoded — used by the X-WECHAT-UIN
 *  request header. The exact value is not validated server-side, but a
 *  valid-looking one is required. */
export function randomWechatUin(): string {
  const buf = crypto.randomBytes(4)
  return buf.toString('base64')
}
