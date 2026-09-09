/**
 * max_tokens forwarding policy: unit tests for the policy itself, plus the
 * proxy handler end-to-end against a stubbed upstream (temp config dir, the
 * providersAuth.test.ts harness).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import {
  isMaxTokensRejection,
  maxTokensAccepted,
  rememberMaxTokensRejected,
  resetMaxTokensPolicyForTests,
  stripMaxTokens,
} from '../proxy/maxTokensPolicy.js'
import { handleProxyRequest } from '../proxy/handler.js'
import { ProviderService } from '../services/providerService.js'
import { anthropicToOpenaiResponses } from '../proxy/transform/anthropicToOpenaiResponses.js'

describe('maxTokensPolicy', () => {
  beforeEach(() => resetMaxTokensPolicyForTests())

  test('a provider is trusted with max_tokens until it rejects it', () => {
    expect(maxTokensAccepted('http://a.example')).toBe(true)
    rememberMaxTokensRejected('http://a.example')
    expect(maxTokensAccepted('http://a.example')).toBe(false)
    // Per provider, not global.
    expect(maxTokensAccepted('http://b.example')).toBe(true)
  })

  test('only a 400 that names the field counts as a rejection of the value', () => {
    expect(isMaxTokensRejection(400, '{"error":{"message":"Invalid max_tokens value, the valid range is [1, 8192]"}}')).toBe(true)
    expect(isMaxTokensRejection(400, 'max_completion_tokens is too large')).toBe(true)
    expect(isMaxTokensRejection(400, '{"error":"model not found"}')).toBe(false)
    expect(isMaxTokensRejection(500, 'max_tokens')).toBe(false)
    expect(isMaxTokensRejection(401, 'max_tokens')).toBe(false)
  })

  test('stripMaxTokens removes every budget field and nothing else', () => {
    const out = stripMaxTokens({ model: 'm', max_tokens: 1, max_output_tokens: 2, max_completion_tokens: 3, messages: [] })
    expect(out).toEqual({ model: 'm', messages: [] })
  })

  test('Responses API carries the budget as max_output_tokens', () => {
    const r = anthropicToOpenaiResponses({ model: 'm', max_tokens: 777, messages: [{ role: 'user', content: 'hi' }] })
    expect((r as unknown as Record<string, unknown>).max_output_tokens).toBe(777)
  })
})

// ─── Handler end-to-end with a stubbed upstream ───────────────────────────

let tmpDir: string
let originalConfigDir: string | undefined
const realFetch = globalThis.fetch
const BASE = 'http://gw.corp.example/svc'

type Seen = { url: string; body: Record<string, unknown> }

function installUpstream(handler: (seen: Seen, n: number) => Response) {
  const seen: Seen[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const s = { url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> }
    seen.push(s)
    return handler(s, seen.length)
  }) as never
  return seen
}

function chatCompletion(text: string, finish = 'stop'): Response {
  return Response.json({
    id: 'c1', object: 'chat.completion', created: 0, model: 'fake',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finish }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

async function proxyRequest(providerId: string, maxTokens = 32000): Promise<Response> {
  const req = new Request(`http://127.0.0.1:3456/proxy/providers/${providerId}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'fake', max_tokens: maxTokens, messages: [{ role: 'user', content: 'hi' }] }),
  })
  return handleProxyRequest(req, new URL(req.url))
}

describe('proxy handler: max_tokens forwarding', () => {
  let providerId: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maxtok-test-'))
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    resetMaxTokensPolicyForTests()
    const svc = new ProviderService()
    const p = await svc.addProvider({
      presetId: 'custom', name: 'gw', apiKey: 'k', baseUrl: BASE, apiFormat: 'openai_chat',
      models: { main: 'fake', haiku: 'fake', sonnet: 'fake', opus: 'fake' },
    })
    providerId = p.id
  })

  afterEach(async () => {
    globalThis.fetch = realFetch
    if (originalConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    else delete process.env.CLAUDE_CONFIG_DIR
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('forwards the CLI budget to the upstream', async () => {
    const seen = installUpstream(() => chatCompletion('ok'))
    const res = await proxyRequest(providerId, 32000)
    expect(res.status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.body.max_tokens).toBe(32000)
  })

  test('a provider that rejects the budget is retried once without it, then remembered', async () => {
    const seen = installUpstream((s) =>
      'max_tokens' in s.body
        ? new Response('{"error":{"message":"Invalid max_tokens value, the valid range is [1, 8192]"}}', { status: 400 })
        : chatCompletion('ok'),
    )
    const res = await proxyRequest(providerId)
    expect(res.status).toBe(200)
    expect(seen.map((s) => 'max_tokens' in s.body)).toEqual([true, false])

    // Next request: no 400 round-trip, the field is simply omitted.
    const res2 = await proxyRequest(providerId)
    expect(res2.status).toBe(200)
    expect(seen).toHaveLength(3)
    expect('max_tokens' in seen[2]!.body).toBe(false)
  })

  test('a 400 for any other reason is returned as-is, not retried', async () => {
    const seen = installUpstream(() => new Response('{"error":{"message":"model not found"}}', { status: 400 }))
    const res = await proxyRequest(providerId)
    expect(res.status).toBe(400)
    expect(seen).toHaveLength(1)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain('model not found')
    // And the provider is still trusted with the budget next time.
    expect(maxTokensAccepted(BASE)).toBe(true)
  })
})
