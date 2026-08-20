/**
 * When the non-streaming fallback returns a response with zero content blocks,
 * the user-facing error carries a bounded diagnostic naming what actually came
 * back (provider soft-error fields like MiniMax's base_resp, proxy-fabricated
 * bodies with non-Anthropic keys) — one report/screenshot must be enough to
 * identify the culprit on a machine we cannot access.
 */
import { describe, expect, test } from 'bun:test'
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { describeEmptyFallbackResponse } from '../../services/api/claude.js'

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

  test('bounds oversized extras and stream error text', () => {
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
