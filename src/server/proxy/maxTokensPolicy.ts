/**
 * Whether to forward the CLI's `max_tokens` to an OpenAI-compatible upstream.
 *
 * The CLI sends its output budget (32k by default). Not forwarding it lets
 * the upstream apply its own default cap - often a few thousand tokens - and
 * a Write tool call carrying a whole file gets cut mid-JSON. The CLI then
 * executes the truncated call, the tool rejects it, the model regenerates
 * the same answer, and the user sees one sentence repeat forever.
 *
 * Some providers reject a budget above their hard limit with HTTP 400. For
 * those the proxy retries once without the field and remembers the
 * rejection for the process lifetime, so a capped provider behaves exactly
 * as before this change after a single extra request.
 */

const rejectedByBase = new Set<string>()

const MAX_TOKENS_FIELDS = ['max_tokens', 'max_output_tokens', 'max_completion_tokens'] as const

export function maxTokensAccepted(baseUrl: string): boolean {
  return !rejectedByBase.has(baseUrl)
}

export function rememberMaxTokensRejected(baseUrl: string): void {
  rejectedByBase.add(baseUrl)
}

/** A 400 whose body names one of the budget fields is the provider refusing the value, not the request. */
export function isMaxTokensRejection(status: number, bodyText: string): boolean {
  if (status !== 400) return false
  return MAX_TOKENS_FIELDS.some((f) => bodyText.includes(f))
}

export function stripMaxTokens<T extends Record<string, unknown>>(body: T): T {
  const out = { ...body }
  for (const f of MAX_TOKENS_FIELDS) delete out[f]
  return out
}

/** Test-only. */
export function resetMaxTokensPolicyForTests(): void {
  rejectedByBase.clear()
}
