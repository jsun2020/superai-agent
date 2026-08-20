/**
 * Anthropic-compatible providers (e.g. MiniMax) can return responses with no
 * usage object. That must never crash the turn ("undefined is not an object
 * (evaluating 'usage.input_tokens')") — usage-consuming code paths either
 * guard or normalize through updateUsage.
 */
import { describe, expect, test } from 'bun:test'
import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { EMPTY_USAGE } from '../../services/api/emptyUsage.js'
import { updateUsage } from '../../services/api/claude.js'
import { getParentCacheSuppressReason } from '../../services/PromptSuggestion/promptSuggestion.js'
import { calculateUSDCost } from '../../utils/modelCost.js'

describe('provider responses without usage', () => {
  test('updateUsage normalizes a missing usage to EMPTY_USAGE values', () => {
    const normalized = updateUsage(EMPTY_USAGE, undefined)
    expect(normalized.input_tokens).toBe(0)
    expect(normalized.output_tokens).toBe(0)
    // Normalized usage must be safe for cost accounting. Use a known model
    // name — unknown models fall back to the default-model lookup, which
    // requires auth env not present in the test environment.
    expect(
      calculateUSDCost('claude-sonnet-4-5-20250929', normalized as BetaUsage),
    ).toBe(0)
  })

  test('getParentCacheSuppressReason tolerates an assistant message without usage', () => {
    const message = {
      type: 'assistant',
      message: {
        id: 'msg_1',
        role: 'assistant',
        model: 'MiniMax-M3',
        content: [{ type: 'text', text: 'hi' }],
        // no usage field at all — as returned by some compat providers
      },
    } as never
    expect(getParentCacheSuppressReason(message)).toBe(null)
  })
})
