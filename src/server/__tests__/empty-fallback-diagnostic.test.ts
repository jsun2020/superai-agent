/**
 * When the non-streaming fallback returns a response with zero content blocks,
 * the user-facing error carries a bounded diagnostic naming what actually came
 * back (provider soft-error fields like MiniMax's base_resp, proxy-fabricated
 * bodies with non-Anthropic keys) — one report/screenshot must be enough to
 * identify the culprit on a machine we cannot access.
 */
import { describe, expect, test } from 'bun:test'
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  buildEmptyFallbackErrorMessage,
  describeEmptyFallbackResponse,
} from '../../services/api/claude.js'

function asBetaMessage(obj: Record<string, unknown>): BetaMessage {
  return obj as unknown as BetaMessage
}

describe('describeEmptyFallbackResponse', () => {
  test('surfaces MiniMax-style base_resp soft errors', () => {
    const diag = describeEmptyFallbackResponse(
      asBetaMessage({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'MiniMax-M3',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 42000, output_tokens: 0 },
        base_resp: { status_code: 1002, status_msg: 'rate limit' },
      }),
      'stream aborted mid-thinking',
    )
    expect(diag).toContain('stream_error=stream aborted mid-thinking')
    expect(diag).toContain('stop_reason=null')
    expect(diag).toContain('usage=in:42000,out:0')
    expect(diag).toContain('base_resp={"status_code":1002,"status_msg":"rate limit"}')
  })

  test('names non-Anthropic keys of a proxy/gateway-fabricated body', () => {
    const diag = describeEmptyFallbackResponse(
      asBetaMessage({
        id: 'x',
        object: 'chat.completion',
        choices: [{ message: { content: 'hi' } }],
        // no content field: normalizeContentFromAPI turns this into []
      }),
      'terminated',
    )
    expect(diag).toContain('response_keys=id,object,choices')
    expect(diag).toContain('usage=absent')
    expect(diag).toContain('extra object="chat.completion"')
  })

  test('reports a non-JSON string body as text, not one key per character', () => {
    // The SDK returns the raw body string when content-type isn't JSON — what a
    // TLS-inspecting proxy produces when it substitutes its own block page.
    const blockPage =
      '<html><head><title>Access Denied</title></head><body>\n  Your request was blocked by the corporate gateway.\n</body></html>'
    const diag = describeEmptyFallbackResponse(
      blockPage as unknown as BetaMessage,
      'InvalidHTTPResponse fetching "https://api.deepseek.com/anthropic/v1/messages?beta=true"',
    )
    expect(diag).toContain('body_type=string (not JSON)')
    expect(diag).toContain(`body_len=${blockPage.length}`)
    expect(diag).toContain('Access Denied')
    expect(diag).toContain('blocked by the corporate gateway')
    // must NOT degenerate into 0,1,2,3... character indices
    expect(diag).not.toContain('response_keys=0,1,2')
  })

  test('bounds a huge key list instead of flooding the message', () => {
    const many: Record<string, unknown> = {}
    for (let i = 0; i < 200; i++) many[`k${i}`] = i
    const diag = describeEmptyFallbackResponse(
      asBetaMessage(many),
      'terminated',
    )
    expect(diag).toContain('(+180 more)')
    expect(diag.length).toBeLessThan(600)
  })

  test('bounds oversized extras and stream error text', () => {
    // (kept below with the other bounding cases)
    const diag = describeEmptyFallbackResponse(
      asBetaMessage({
        content: [],
        blob: 'z'.repeat(5000),
      }),
      `line1\nline2 ${'e'.repeat(500)}`,
    )
    // extras bounded to ~200 chars + ellipsis; newlines in stream error collapsed
    const extraPart = diag.split('extra ')[1]
    expect(extraPart.length).toBeLessThanOrEqual(203)
    expect(diag).not.toContain('\n')
    const streamPart = diag.split(';')[0]
    expect(streamPart.length).toBeLessThanOrEqual('stream_error='.length + 120)
  })
})

describe('buildEmptyFallbackErrorMessage', () => {
  // Verbatim shape observed on the corporate Win11 machine: the SDK resolved to
  // the response TEXT because the content-type was not JSON, and the text was an
  // interception page.
  const INTERCEPT_PAGE =
    '<html><head>\n<meta http-equiv="Content-Type" content="text/html; charset=utf-8">\n<title>Access Denied</title></head><body>Request blocked by the security gateway.</body></html>'

  test('names interception, not a provider outage, for an HTML body', () => {
    const msg = buildEmptyFallbackErrorMessage(
      INTERCEPT_PAGE as unknown as BetaMessage,
      'InvalidHTTPResponse fetching "https://api.deepseek.com/anthropic/v1/messages?beta=true"',
      'https://api.deepseek.com/anthropic/v1/messages',
    )
    expect(msg).toContain('HTML page instead of a model response')
    expect(msg).toContain('intercepting requests')
    expect(msg).toContain('https://api.deepseek.com/anthropic/v1/messages')
    expect(msg).toContain('not a provider outage')
    // the page's own words must survive into the message
    expect(msg).toContain('Access Denied')
    // and it must NOT claim the provider returned an empty response
    expect(msg).not.toContain('provider returned an empty response')
  })

  test('distinguishes a non-HTML non-JSON body from an HTML one', () => {
    const msg = buildEmptyFallbackErrorMessage(
      'upstream connect error or disconnect/reset before headers' as unknown as BetaMessage,
      'terminated',
    )
    expect(msg).toContain('non-JSON response')
    expect(msg).not.toContain('HTML page instead')
    expect(msg).toContain('upstream connect error')
  })

  test('keeps the original wording for a genuinely empty JSON message', () => {
    const msg = buildEmptyFallbackErrorMessage(
      asBetaMessage({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 0 },
      }),
      'Stream ended without receiving any events',
    )
    expect(msg).toContain('provider returned an empty response')
    expect(msg).not.toContain('HTML page')
    expect(msg).toContain('stop_reason=end_turn')
  })
})
