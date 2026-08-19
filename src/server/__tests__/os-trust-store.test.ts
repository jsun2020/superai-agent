/**
 * SuperAI trusts the operating system's certificate store by default on
 * Windows / macOS, so a corporate TLS-inspecting proxy (whose CA sits in the
 * OS store) no longer kills every API call with "Self-signed certificate
 * detected".
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { X509Certificate } from 'node:crypto'
import tls from 'node:tls'
import {
  clearCACertsCache,
  getCACertificates,
  shouldTrustOsCertStore,
} from '../../utils/caCerts.js'

const ENV_KEYS = ['SUPERAI_USE_SYSTEM_CA', 'NODE_USE_SYSTEM_CA', 'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS']
let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
  for (const k of ENV_KEYS) delete process.env[k]
  clearCACertsCache()
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  clearCACertsCache()
})

const onDesktopOs = process.platform === 'win32' || process.platform === 'darwin'
const systemCerts = (): string[] => {
  const fn = (tls as typeof tls & { getCACertificates?: (t: string) => string[] }).getCACertificates
  return fn ? fn('system') : []
}
const fingerprints = (pems: string[]) =>
  new Set(pems.map(p => new X509Certificate(p).fingerprint256))

describe('shouldTrustOsCertStore', () => {
  test('is on by default on Windows and macOS', () => {
    expect(shouldTrustOsCertStore()).toBe(onDesktopOs)
  })
  test('SUPERAI_USE_SYSTEM_CA=0 opts out, =1 opts in', () => {
    process.env.SUPERAI_USE_SYSTEM_CA = '0'
    expect(shouldTrustOsCertStore()).toBe(false)
    process.env.SUPERAI_USE_SYSTEM_CA = '1'
    expect(shouldTrustOsCertStore()).toBe(true)
  })
  test("honours Node's NODE_USE_SYSTEM_CA when SUPERAI_USE_SYSTEM_CA is unset", () => {
    process.env.NODE_USE_SYSTEM_CA = 'false'
    expect(shouldTrustOsCertStore()).toBe(false)
  })
})

describe('getCACertificates with the OS trust store', () => {
  test.skipIf(!onDesktopOs)('returns bundled roots PLUS every OS-store certificate by default', () => {
    const sys = systemCerts()
    if (sys.length === 0) return // runtime without a system store API
    const certs = getCACertificates()
    expect(certs).toBeDefined()
    const got = fingerprints(certs!)
    for (const fp of fingerprints(tls.rootCertificates as string[])) expect(got.has(fp)).toBe(true)
    for (const fp of fingerprints(sys)) expect(got.has(fp)).toBe(true)
    // The point of the change: an OS-store CA that Mozilla does not ship (a
    // corporate root such as "SAIC-GM Root CA" on the build machine) is trusted.
    const bundled = fingerprints(tls.rootCertificates as string[])
    const corporate = sys.filter(p => !bundled.has(new X509Certificate(p).fingerprint256))
    if (corporate.length > 0) {
      expect(certs!.some(c => c === corporate[0])).toBe(true)
    }
  })

  test.skipIf(!onDesktopOs)('SUPERAI_USE_SYSTEM_CA=0 restores the upstream default (runtime CA list)', () => {
    process.env.SUPERAI_USE_SYSTEM_CA = '0'
    expect(getCACertificates()).toBeUndefined()
  })

  test.skipIf(!onDesktopOs)('NODE_EXTRA_CA_CERTS is still appended on top of bundled + OS store', () => {
    // any PEM on disk will do - reuse one system cert written to a temp file
    const sys = systemCerts()
    if (sys.length === 0) return
    const fs = require('node:fs') as typeof import('node:fs')
    const os = require('node:os') as typeof import('node:os')
    const path = require('node:path') as typeof import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superai-ca-'))
    const file = path.join(dir, 'extra.pem')
    fs.writeFileSync(file, '# extra bundle\n' + sys[0])
    process.env.NODE_EXTRA_CA_CERTS = file
    const certs = getCACertificates()
    expect(certs).toBeDefined()
    expect(certs!.at(-1)).toContain('# extra bundle')
    expect(certs!.length).toBe(tls.rootCertificates.length + sys.length + 1)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
