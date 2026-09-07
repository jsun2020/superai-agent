/**
 * Unit tests for proxy upstream authentication.
 *
 * globalThis.fetch is stubbed per test (the convention from pac.test.ts) and
 * routed by URL, so the token endpoint and the upstream are both fake.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  buildUpstreamHeaders,
  fetchUpstream,
  resolveUpstreamUrl,
  API_KEY_HEADER,
} from '../proxy/upstreamAuth.js'
import { resetTokenSourcesForTests } from '../services/oauthClientCredentials.js'
import type { ProviderAuth } from '../types/provider.js'

const TOKEN_URL = 'http://gateway.corp.example/oauth2/token'
const UPSTREAM = 'http://gateway.corp.example/svc/v1/chat/completions'

const OAUTH: ProviderAuth = {
  type: 'oauth2_client_credentials',
  tokenUrl: TOKEN_URL,
  clientId: 'cid',
  clientSecret: 'csec',
}

type Seen = { url: string; headers: Record<string, string>; body: string }

/**
 * Install a fetch stub. `tokens` are handed out in order by the token endpoint;
 * `upstream` decides the upstream status from the bearer it sees.
 */
function installFetch(tokens: string[], upstream: (bearer: string | undefined) => number) {
  const seen: Seen[] = []
  let tokenCalls = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string>) ?? {}),
    )
    seen.push({ url, headers, body: String(init?.body ?? '') })
    if (url === TOKEN_URL) {
      const token = tokens[Math.min(tokenCalls, tokens.length - 1)]
      tokenCalls++
      return Response.json({ access_token: token, expires_in: 600 })
    }
    const bearer = headers.Authorization?.replace(/^Bearer /, '')
    const status = upstream(bearer)
    return new Response(status === 200 ? '{"ok":true}' : 'nope', { status })
  }) as never
  return { seen, tokenCalls: () => tokenCalls }
}

const realFetch = globalThis.fetch

beforeEach(() => resetTokenSourcesForTests())
afterEach(() => {
  globalThis.fetch = realFetch
  resetTokenSourcesForTests()
})

describe('buildUpstreamHeaders', () => {
  test('a plain API key produces exactly the headers the proxy always sent', async () => {
    // Regression guard: existing providers must be byte-for-byte unaffected.
    const headers = await buildUpstreamHeaders({ apiKey: 'sk-1' })
    expect(headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-1',
    })
  })

  test('oauth carries the fetched token as bearer and the key as X-API-KEY', async () => {
    installFetch(['tok-1'], () => 200)
    const headers = await buildUpstreamHeaders({ apiKey: 'xk-9', auth: OAUTH })
    expect(headers.Authorization).toBe('Bearer tok-1')
    expect(headers[API_KEY_HEADER]).toBe('xk-9')
    expect(headers['Content-Type']).toBe('application/json')
  })

  test('oauth with no static key omits X-API-KEY rather than sending an empty one', async () => {
    installFetch(['tok-1'], () => 200)
    const headers = await buildUpstreamHeaders({ apiKey: '', auth: OAUTH })
    expect(headers.Authorization).toBe('Bearer tok-1')
    expect(API_KEY_HEADER in headers).toBe(false)
  })

  test('an explicit null auth behaves like a plain key', async () => {
    const headers = await buildUpstreamHeaders({ apiKey: 'sk-1', auth: null })
    expect(headers.Authorization).toBe('Bearer sk-1')
  })
})

describe('resolveUpstreamUrl', () => {
  test('appends the path to an OpenAI-style base', () => {
    expect(resolveUpstreamUrl('https://api.example.com', '/v1/chat/completions'))
      .toBe('https://api.example.com/v1/chat/completions')
  })

  test('does not double /v1 when the base already ends with it', () => {
    // The shape enterprise gateways hand out: BASE_URL=.../service/v1
    expect(resolveUpstreamUrl('http://gw.corp.example/svc/v1', '/v1/chat/completions'))
      .toBe('http://gw.corp.example/svc/v1/chat/completions')
    expect(resolveUpstreamUrl('http://gw.corp.example/svc/v1/', '/v1/responses'))
      .toBe('http://gw.corp.example/svc/v1/responses')
  })

  test('trims trailing slashes', () => {
    expect(resolveUpstreamUrl('https://api.example.com///', '/v1/responses'))
      .toBe('https://api.example.com/v1/responses')
  })

  test('only /v1 itself is deduplicated, not a path that merely contains it', () => {
    expect(resolveUpstreamUrl('https://api.example.com/v1beta', '/v1/chat/completions'))
      .toBe('https://api.example.com/v1beta/v1/chat/completions')
  })
})

describe('fetchUpstream', () => {
  test('sends the body with the resolved headers', async () => {
    const { seen } = installFetch([], () => 200)
    const res = await fetchUpstream(UPSTREAM, { model: 'm' }, { apiKey: 'sk-1' }, { timeoutMs: 1000 })
    expect(res.status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.headers.Authorization).toBe('Bearer sk-1')
    expect(JSON.parse(seen[0]!.body)).toEqual({ model: 'm' })
  })

  test('a 401 on a stale oauth token is retried once with a fresh one', async () => {
    const { seen, tokenCalls } = installFetch(['tok-old', 'tok-new'], (b) => (b === 'tok-new' ? 200 : 401))
    const res = await fetchUpstream(UPSTREAM, {}, { apiKey: 'xk', auth: OAUTH }, { timeoutMs: 1000 })
    expect(res.status).toBe(200)
    expect(tokenCalls()).toBe(2)
    const upstreamCalls = seen.filter((s) => s.url === UPSTREAM)
    expect(upstreamCalls.map((s) => s.headers.Authorization)).toEqual(['Bearer tok-old', 'Bearer tok-new'])
  })

  test('a second 401 is returned as-is — no loop on the token endpoint', async () => {
    const { seen, tokenCalls } = installFetch(['tok-1', 'tok-2', 'tok-3'], () => 401)
    const res = await fetchUpstream(UPSTREAM, {}, { apiKey: 'xk', auth: OAUTH }, { timeoutMs: 1000 })
    expect(res.status).toBe(401)
    expect(tokenCalls()).toBe(2)
    expect(seen.filter((s) => s.url === UPSTREAM)).toHaveLength(2)
  })

  test('a 401 on a plain API key is not retried — a wrong key does not fix itself', async () => {
    const { seen } = installFetch([], () => 401)
    const res = await fetchUpstream(UPSTREAM, {}, { apiKey: 'sk-bad' }, { timeoutMs: 1000 })
    expect(res.status).toBe(401)
    expect(seen).toHaveLength(1)
  })

  test('a successful oauth call reuses the cached token on the next request', async () => {
    const { tokenCalls } = installFetch(['tok-1'], () => 200)
    await fetchUpstream(UPSTREAM, {}, { apiKey: 'xk', auth: OAUTH }, { timeoutMs: 1000 })
    await fetchUpstream(UPSTREAM, {}, { apiKey: 'xk', auth: OAUTH }, { timeoutMs: 1000 })
    expect(tokenCalls()).toBe(1)
  })
})
