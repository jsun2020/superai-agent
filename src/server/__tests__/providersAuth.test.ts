/**
 * OAuth2 client-credentials auth on saved providers: persistence, masking,
 * update semantics, and the format guard. Same temp-config-dir harness as
 * providers.test.ts.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { ProviderService } from '../services/providerService.js'
import { handleProvidersApi } from '../api/providers.js'
import type { CreateProviderInput, ProviderAuth } from '../types/provider.js'

let tmpDir: string
let originalConfigDir: string | undefined

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-auth-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(async () => {
  if (originalConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  else delete process.env.CLAUDE_CONFIG_DIR
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const OAUTH: ProviderAuth = {
  type: 'oauth2_client_credentials',
  tokenUrl: 'http://gateway.corp.example/oauth2/token',
  clientId: 'client-id-1',
  clientSecret: 'client-secret-1',
}

function oauthInput(overrides?: Partial<CreateProviderInput>): CreateProviderInput {
  return {
    presetId: 'custom',
    name: 'Corp gateway',
    baseUrl: 'http://gateway.corp.example/svc/v1',
    apiKey: 'x-api-key-value',
    apiFormat: 'openai_chat',
    models: { main: 'corp-model', haiku: 'corp-model', sonnet: 'corp-model', opus: 'corp-model' },
    auth: OAUTH,
    ...overrides,
  }
}

function makeRequest(method: string, urlStr: string, body?: Record<string, unknown>) {
  const url = new URL(urlStr, 'http://localhost:3456')
  const init: RequestInit = { method }
  if (body) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  return { req: new Request(url.toString(), init), url, segments: url.pathname.split('/').filter(Boolean) }
}

async function readProvidersFile(): Promise<{ providers: Array<Record<string, unknown>> }> {
  const raw = await fs.readFile(path.join(tmpDir, 'superai', 'providers.json'), 'utf-8')
  return JSON.parse(raw)
}

describe('ProviderService oauth auth', () => {
  test('persists the auth block verbatim', async () => {
    const svc = new ProviderService()
    const added = await svc.addProvider(oauthInput())
    expect(added.auth).toEqual(OAUTH)

    const onDisk = await readProvidersFile()
    expect(onDisk.providers[0]!.auth).toEqual(OAUTH)
  })

  test('a bearer provider stores no auth key at all', async () => {
    // Regression guard: existing providers.json shape is unchanged.
    const svc = new ProviderService()
    const added = await svc.addProvider(oauthInput({ auth: undefined }))
    expect('auth' in added).toBe(false)
    const onDisk = await readProvidersFile()
    expect('auth' in onDisk.providers[0]!).toBe(false)
  })

  test('rejects oauth on a native Anthropic provider', async () => {
    const svc = new ProviderService()
    await expect(svc.addProvider(oauthInput({ apiFormat: 'anthropic' }))).rejects.toThrow(/OpenAI-compatible/)
  })

  test('rejects oauth without a client secret on create', async () => {
    const svc = new ProviderService()
    await expect(svc.addProvider(oauthInput({ auth: { ...OAUTH, clientSecret: '' } })))
      .rejects.toThrow(/client secret/)
  })

  test('update with a blank secret keeps the stored one', async () => {
    const svc = new ProviderService()
    const added = await svc.addProvider(oauthInput())
    const updated = await svc.updateProvider(added.id, {
      auth: { ...OAUTH, clientId: 'client-id-2', clientSecret: '' },
    })
    expect(updated.auth?.clientId).toBe('client-id-2')
    expect(updated.auth?.clientSecret).toBe('client-secret-1')
  })

  test('update with a new secret replaces it', async () => {
    const svc = new ProviderService()
    const added = await svc.addProvider(oauthInput())
    const updated = await svc.updateProvider(added.id, { auth: { ...OAUTH, clientSecret: 'rotated' } })
    expect(updated.auth?.clientSecret).toBe('rotated')
  })

  test('update with auth: null drops back to a plain bearer key', async () => {
    const svc = new ProviderService()
    const added = await svc.addProvider(oauthInput())
    const updated = await svc.updateProvider(added.id, { auth: null })
    expect('auth' in updated).toBe(false)
    const onDisk = await readProvidersFile()
    expect('auth' in onDisk.providers[0]!).toBe(false)
  })

  test('update leaving auth undefined keeps it', async () => {
    const svc = new ProviderService()
    const added = await svc.addProvider(oauthInput())
    const updated = await svc.updateProvider(added.id, { name: 'renamed' })
    expect(updated.auth).toEqual(OAUTH)
  })

  test('switching an oauth provider to anthropic format is rejected', async () => {
    const svc = new ProviderService()
    const added = await svc.addProvider(oauthInput())
    await expect(svc.updateProvider(added.id, { apiFormat: 'anthropic' })).rejects.toThrow(/OpenAI-compatible/)
  })

  test('the proxy config carries auth', async () => {
    const svc = new ProviderService()
    const added = await svc.addProvider(oauthInput())
    const cfg = await svc.getProviderForProxy(added.id)
    expect(cfg?.auth).toEqual(OAUTH)
    expect(cfg?.apiKey).toBe('x-api-key-value')
    expect(cfg?.apiFormat).toBe('openai_chat')
  })

  test('the proxy config for a bearer provider has no auth key', async () => {
    const svc = new ProviderService()
    const added = await svc.addProvider(oauthInput({ auth: undefined }))
    const cfg = await svc.getProviderForProxy(added.id)
    expect(cfg && 'auth' in cfg).toBe(false)
  })

  test('an active oauth provider counts as auth even with an empty X-API-KEY', async () => {
    const svc = new ProviderService()
    const added = await svc.addProvider(oauthInput({ apiKey: '' }))
    await svc.activateProvider(added.id)
    const status = await svc.checkAuthStatus()
    expect(status.hasAuth).toBe(true)
    expect(status.source).toBe('superai-provider')
  })

  test('activating an oauth provider routes the CLI through the local proxy', async () => {
    const svc = new ProviderService()
    const added = await svc.addProvider(oauthInput())
    await svc.activateProvider(added.id)
    const raw = await fs.readFile(path.join(tmpDir, 'superai', 'settings.json'), 'utf-8')
    const env = (JSON.parse(raw) as { env: Record<string, string> }).env
    expect(env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/proxy$/)
    // The secret must never be written to settings.json - the CLI never sees it.
    expect(raw).not.toContain('client-secret-1')
    expect(raw).not.toContain('x-api-key-value')
  })
})

describe('Providers API oauth masking', () => {
  test('GET list masks the client secret alongside the API key', async () => {
    const svc = new ProviderService()
    await svc.addProvider(oauthInput({ apiKey: 'x-api-key-value-long', auth: { ...OAUTH, clientSecret: 'client-secret-long' } }))

    const { req, url, segments } = makeRequest('GET', '/api/providers')
    const res = await handleProvidersApi(req, url, segments)
    const body = (await res.json()) as { providers: Array<{ apiKey: string; auth?: ProviderAuth }> }
    const p = body.providers[0]!
    expect(p.apiKey).not.toContain('key-value-long')
    expect(p.auth?.clientSecret).not.toContain('secret-long')
    expect(p.auth?.clientSecret).toContain('****')
    // Non-secret fields are still shown so the edit form can populate them.
    expect(p.auth?.tokenUrl).toBe(OAUTH.tokenUrl)
    expect(p.auth?.clientId).toBe(OAUTH.clientId)
  })

  test('GET one masks it too', async () => {
    const svc = new ProviderService()
    const added = await svc.addProvider(oauthInput({ auth: { ...OAUTH, clientSecret: 'client-secret-long' } }))
    const { req, url, segments } = makeRequest('GET', `/api/providers/${added.id}`)
    const res = await handleProvidersApi(req, url, segments)
    const body = (await res.json()) as { provider: { auth?: ProviderAuth } }
    expect(body.provider.auth?.clientSecret).not.toContain('secret-long')
  })

  test('POST create accepts the auth block and rejects a malformed one', async () => {
    const ok = makeRequest('POST', '/api/providers', oauthInput() as unknown as Record<string, unknown>)
    const okRes = await handleProvidersApi(ok.req, ok.url, ok.segments)
    expect(okRes.status).toBe(201)

    const bad = makeRequest('POST', '/api/providers', {
      ...oauthInput(),
      auth: { type: 'oauth2_client_credentials', clientId: 'x', clientSecret: 'y' }, // no tokenUrl
    })
    const badRes = await handleProvidersApi(bad.req, bad.url, bad.segments)
    expect(badRes.status).toBe(400)
  })

  test('POST create with oauth on anthropic format is a 400, not a 500', async () => {
    const r = makeRequest('POST', '/api/providers', oauthInput({ apiFormat: 'anthropic' }) as unknown as Record<string, unknown>)
    const res = await handleProvidersApi(r.req, r.url, r.segments)
    expect(res.status).toBe(400)
  })
})
