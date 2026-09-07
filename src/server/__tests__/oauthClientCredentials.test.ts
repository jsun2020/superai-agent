/**
 * Unit tests for the OAuth2 client-credentials token source.
 *
 * Hermetic: fetch and the clock are injected, so nothing here touches the
 * network or depends on wall time.
 */

import { describe, test, expect } from 'bun:test'
import {
  ClientCredentialsTokenSource,
  DEFAULT_TOKEN_TTL_MS,
  TOKEN_GRACE_MS,
  getTokenSource,
  resetTokenSourcesForTests,
} from '../services/oauthClientCredentials.js'

const CONFIG = {
  tokenUrl: 'http://gateway.corp.example/oauth2/token',
  clientId: 'client-abc',
  clientSecret: 'secret-xyz',
}

type Call = { url: string; init: RequestInit }

/** A fetch stub that records calls and answers from a queue of responders. */
function fakeFetch(responders: Array<(call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} }
    calls.push(call)
    const responder = responders.length > 1 ? responders.shift()! : responders[0]!
    return responder(call)
  }) as unknown as typeof fetch
  return { impl, calls }
}

function tokenResponse(token: string, expiresIn?: number): Response {
  return Response.json(expiresIn === undefined ? { access_token: token } : { access_token: token, expires_in: expiresIn })
}

describe('ClientCredentialsTokenSource', () => {
  test('posts a form-encoded client_credentials grant and returns the token', async () => {
    const { impl, calls } = fakeFetch([() => tokenResponse('tok-1', 600)])
    const source = new ClientCredentialsTokenSource(CONFIG, { fetch: impl })

    expect(await source.getToken()).toBe('tok-1')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(CONFIG.tokenUrl)
    expect(calls[0]!.init.method).toBe('POST')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    const form = new URLSearchParams(String(calls[0]!.init.body))
    expect(form.get('grant_type')).toBe('client_credentials')
    expect(form.get('client_id')).toBe('client-abc')
    expect(form.get('client_secret')).toBe('secret-xyz')
    // Gateways of this kind expect a scope; the default matches what they accept.
    expect(form.get('scope')).toBe('ALL')
  })

  test('honours an explicit scope', async () => {
    const { impl, calls } = fakeFetch([() => tokenResponse('tok-1')])
    const source = new ClientCredentialsTokenSource({ ...CONFIG, scope: 'read' }, { fetch: impl })
    await source.getToken()
    expect(new URLSearchParams(String(calls[0]!.init.body)).get('scope')).toBe('read')
  })

  test('serves the cached token until the grace window', async () => {
    let now = 1_000_000
    const { impl, calls } = fakeFetch([() => tokenResponse('tok-1', 600)])
    const source = new ClientCredentialsTokenSource(CONFIG, { fetch: impl, now: () => now })

    await source.getToken()
    now += 600_000 - TOKEN_GRACE_MS - 1
    expect(await source.getToken()).toBe('tok-1')
    expect(calls).toHaveLength(1)
  })

  test('refreshes once inside the grace window', async () => {
    let now = 1_000_000
    const { impl, calls } = fakeFetch([() => tokenResponse('tok-1', 600), () => tokenResponse('tok-2', 600)])
    const source = new ClientCredentialsTokenSource(CONFIG, { fetch: impl, now: () => now })

    await source.getToken()
    now += 600_000 - TOKEN_GRACE_MS
    expect(await source.getToken()).toBe('tok-2')
    expect(calls).toHaveLength(2)
  })

  test('assumes the default TTL when expires_in is absent', async () => {
    let now = 1_000_000
    const { impl, calls } = fakeFetch([() => tokenResponse('tok-1'), () => tokenResponse('tok-2')])
    const source = new ClientCredentialsTokenSource(CONFIG, { fetch: impl, now: () => now })

    await source.getToken()
    now += DEFAULT_TOKEN_TTL_MS - TOKEN_GRACE_MS - 1
    await source.getToken()
    expect(calls).toHaveLength(1)
    now += 1
    await source.getToken()
    expect(calls).toHaveLength(2)
  })

  test('concurrent callers share one in-flight request', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { impl, calls } = fakeFetch([async () => {
      await gate
      return tokenResponse('tok-1', 600)
    }])
    const source = new ClientCredentialsTokenSource(CONFIG, { fetch: impl })

    const a = source.getToken()
    const b = source.getToken()
    const c = source.refresh()
    release()
    expect(await Promise.all([a, b, c])).toEqual(['tok-1', 'tok-1', 'tok-1'])
    expect(calls).toHaveLength(1)
  })

  test('invalidate() forces a new token on the next call', async () => {
    const { impl, calls } = fakeFetch([() => tokenResponse('tok-1', 600), () => tokenResponse('tok-2', 600)])
    const source = new ClientCredentialsTokenSource(CONFIG, { fetch: impl })

    await source.getToken()
    source.invalidate()
    expect(await source.getToken()).toBe('tok-2')
    expect(calls).toHaveLength(2)
  })

  test('a rejected grant names the status and points at the credentials', async () => {
    const { impl } = fakeFetch([() => new Response('invalid_client', { status: 401 })])
    const source = new ClientCredentialsTokenSource(CONFIG, { fetch: impl })

    const err = await source.getToken().catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('HTTP 401')
    expect((err as Error).message).toContain('client ID and client secret')
    expect((err as Error).message).toContain('invalid_client')
  })

  test('a 5xx is reported without the credentials hint', async () => {
    const { impl } = fakeFetch([() => new Response('', { status: 503 })])
    const source = new ClientCredentialsTokenSource(CONFIG, { fetch: impl })

    const err = await source.getToken().catch((e: Error) => e)
    expect((err as Error).message).toContain('HTTP 503')
    expect((err as Error).message).not.toContain('client ID')
  })

  test('a timeout is reported as a timeout, not a generic failure', async () => {
    const { impl } = fakeFetch([() => {
      throw new DOMException('aborted', 'TimeoutError')
    }])
    const source = new ClientCredentialsTokenSource(CONFIG, { fetch: impl })

    const err = await source.getToken().catch((e: Error) => e)
    expect((err as Error).message).toMatch(/timed out after \d+s/)
  })

  test('a body without access_token is an error, not an empty bearer', async () => {
    const { impl } = fakeFetch([() => Response.json({ token_type: 'Bearer' })])
    const source = new ClientCredentialsTokenSource(CONFIG, { fetch: impl })

    const err = await source.getToken().catch((e: Error) => e)
    expect((err as Error).message).toContain('no access_token')
  })

  test('a failed fetch does not poison the next attempt', async () => {
    const { impl, calls } = fakeFetch([() => new Response('', { status: 503 }), () => tokenResponse('tok-1', 600)])
    const source = new ClientCredentialsTokenSource(CONFIG, { fetch: impl })

    await expect(source.getToken()).rejects.toThrow()
    expect(await source.getToken()).toBe('tok-1')
    expect(calls).toHaveLength(2)
  })
})

describe('getTokenSource', () => {
  test('returns the same source for the same credentials, a new one when the secret changes', () => {
    resetTokenSourcesForTests()
    const a = getTokenSource(CONFIG)
    const b = getTokenSource({ ...CONFIG })
    const c = getTokenSource({ ...CONFIG, clientSecret: 'rotated' })
    expect(a).toBe(b)
    expect(c).not.toBe(a)
    resetTokenSourcesForTests()
  })
})
