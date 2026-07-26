import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerVendorBinDir } from '../../utils/vendorBinDir.js'

const SEP = process.platform === 'win32' ? ';' : ':'

function makeExeWithVendor(): { execPath: string; vendorDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-bin-'))
  const vendorDir = path.join(root, 'vendor')
  fs.mkdirSync(vendorDir)
  return { execPath: path.join(root, 'superai-agent-sidecar.exe'), vendorDir }
}

describe('registerVendorBinDir', () => {
  test('prepends the exe-adjacent vendor dir to PATH when it exists', () => {
    const { execPath, vendorDir } = makeExeWithVendor()
    const env: Record<string, string | undefined> = { PATH: 'C:\\existing' }
    const result = registerVendorBinDir(execPath, env)
    expect(result).toBe(vendorDir)
    expect(env.PATH).toBe(`${vendorDir}${SEP}C:\\existing`)
  })

  test('is a no-op when no vendor dir exists next to the exe (dev mode)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-bin-'))
    const env: Record<string, string | undefined> = { PATH: 'C:\\existing' }
    const result = registerVendorBinDir(path.join(root, 'bun.exe'), env)
    expect(result).toBeNull()
    expect(env.PATH).toBe('C:\\existing')
  })

  test('does not duplicate an entry already on PATH', () => {
    const { execPath, vendorDir } = makeExeWithVendor()
    const env: Record<string, string | undefined> = {
      PATH: `${vendorDir}${SEP}C:\\existing`,
    }
    const result = registerVendorBinDir(execPath, env)
    expect(result).toBe(vendorDir)
    expect(env.PATH).toBe(`${vendorDir}${SEP}C:\\existing`)
  })

  test('handles a missing PATH variable', () => {
    const { execPath, vendorDir } = makeExeWithVendor()
    const env: Record<string, string | undefined> = {}
    const result = registerVendorBinDir(execPath, env)
    expect(result).toBe(vendorDir)
    expect(env.PATH).toBe(vendorDir)
  })
})
