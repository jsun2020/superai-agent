/**
 * When the non-streaming fallback returns a response with zero content blocks,
 * the user-facing error carries a bounded diagnostic naming what actually came
 * back (provider soft-error fields like MiniMax's base_resp, proxy-fabricated
 * bodies with non-Anthropic keys) — one report/screenshot must be enough to
 * identify the culprit on a machine we cannot access.
 */
import { describe, expect, test } from 'bun:test'
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from '@anthropic-ai/sdk'
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  buildEmptyFallbackErrorMessage,
  describeEmptyFallbackResponse,
  BLOCK_PAGE_MAX_ATTEMPTS,
  shouldRetryEmptyFallback,
} from '../../services/api/claude.js'
import {
  buildProxyAuthErrorMessage,
  describeNetworkRoute,
  EmptyFallbackRetryableError,
  getAssistantMessageFromError,
  parseProxyAuthSchemes,
} from '../../services/api/errors.js'
import {
  PROXY_AUTH_MAX_ATTEMPTS,
  shouldRetry,
} from '../../services/api/withRetry.js'

/** Minimal stand-in for the SDK's Headers on an APIError. */
function headersOf(value?: string) {
  return {
    get: (name: string) =>
      name.toLowerCase() === 'proxy-authenticate' ? (value ?? null) : null,
  }
}

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

// Verbatim shape observed on the corporate Win11 machine: the SDK resolved to
// the response TEXT because the content-type was not JSON, and the text was an
// interception page. Module-scoped so the retry-decision tests below reuse the
// exact bodies the message tests assert on.
const INTERCEPT_PAGE =
  '<html><head>\n<meta http-equiv="Content-Type" content="text/html; charset=utf-8">\n<title>Access Denied</title></head><body>Request blocked by the security gateway.</body></html>'

// The corporate proxy's own URL-filter page, as seen on the Win11 machine:
// the request DID go through the configured proxy and the proxy refused it.
const URL_FILTER_PAGE =
  '<html><head> <meta http-equiv="Content-Type" content="text/html; charset=utf-8"> <title>URL Filter</title></head><body>access denied</body></html>'

describe('buildEmptyFallbackErrorMessage', () => {
  test('names interception, not a provider outage, for an HTML body', () => {
    const msg = buildEmptyFallbackErrorMessage(
      INTERCEPT_PAGE as unknown as BetaMessage,
      'InvalidHTTPResponse fetching "https://api.deepseek.com/anthropic/v1/messages?beta=true"',
      'https://api.deepseek.com/anthropic/v1/messages',
      // Explicit env: this case is "no proxy configured", and defaulting to
      // process.env would make the assertion depend on the developer's machine.
      {},
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

  test('blames the proxy itself when the block page arrived THROUGH a proxy', () => {
    const msg = buildEmptyFallbackErrorMessage(
      URL_FILTER_PAGE as unknown as BetaMessage,
      'InvalidHTTPResponse fetching "https://api.minimaxi.com/anthropic/v1/messages?beta=true"',
      'https://api.minimaxi.com/anthropic/v1/messages',
      {
        HTTPS_PROXY: 'http://proxy.corp.example:8080',
        SUPERAI_PROXY_SOURCE: 'settings',
      },
    )
    // The actionable half: the route is already correct, so telling the user
    // something is "intercepting" would send them to fix a setting that is fine.
    expect(msg).toContain('refused this URL')
    expect(msg).toContain('filtering policy on the proxy')
    expect(msg).toContain('not a missing proxy setting')
    expect(msg).not.toContain('captive portal')
    // the diagnostic tail still identifies which proxy and where it came from
    expect(msg).toContain('route=proxy http://proxy.corp.example:8080')
    expect(msg).toContain('proxy_source=settings')
    // the page's own words survive
    expect(msg).toContain('access denied')
  })

  test('same page WITHOUT a proxy still reads as interception (control)', () => {
    const msg = buildEmptyFallbackErrorMessage(
      URL_FILTER_PAGE as unknown as BetaMessage,
      'InvalidHTTPResponse',
      'https://api.minimaxi.com/anthropic/v1/messages',
      { SUPERAI_PROXY_SOURCE: 'none' },
    )
    // Identical body, opposite verdict - proving the branch keys on the ROUTE
    // and not on anything in the page.
    expect(msg).toContain('intercepting requests')
    expect(msg).not.toContain('filtering policy on the proxy')
    expect(msg).toContain('route=direct')
  })

  test('names the endpoint even when the stream error does not embed one', () => {
    // The Win11 case: "Stream ended without receiving any events" carries no
    // URL, so without the explicit argument the message cannot say WHICH host
    // was blocked - provider traffic and any other host look identical.
    const msg = buildEmptyFallbackErrorMessage(
      URL_FILTER_PAGE as unknown as BetaMessage,
      'Stream ended without receiving any events',
      'https://api.minimaxi.com/anthropic/v1',
      {
        HTTPS_PROXY: 'http://proxy.corp.example:8080',
        SUPERAI_PROXY_SOURCE: 'pac',
      },
    )
    expect(msg).toContain('https://api.minimaxi.com/anthropic/v1')
    expect(msg).toContain('proxy_source=pac')
    expect(msg).toContain('refused this URL')
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

/**
 * On an unstable link the empty fallback used to end the turn, so every blip
 * became a manual retry ("hi?" until it answers) - the error text even said
 * "please try again", asking the user to do the retry the app already knows how
 * to do. These pin the two halves of the fix: the error must be retryable, and
 * an exhausted retry must still show the diagnostic rather than a generic
 * connection message.
 */
describe('EmptyFallbackRetryableError', () => {
  const DIAG =
    'API Error: The provider returned an empty response after the streaming connection was interrupted. [diagnostic: stream_error=Stream ended without receiving any events; route=proxy http://proxy.corp.example:8080; proxy_source=pac]'

  test('is an APIConnectionError, which is what makes withRetry retry it', () => {
    // withRetry drops any error failing `error instanceof APIError` before
    // shouldRetry() is consulted, and shouldRetry() returns true for
    // APIConnectionError. A plain Error here is exactly why the turn used to end.
    const err = new EmptyFallbackRetryableError(DIAG)
    expect(err).toBeInstanceOf(APIConnectionError)
  })

  test('its message avoids the word timeout, which would erase the diagnostic', () => {
    // getAssistantMessageFromError replaces any APIConnectionError whose message
    // mentions "timeout" with a generic string. The diagnostic can quote a proxy
    // page containing that word, so the message must stay fixed.
    const err = new EmptyFallbackRetryableError(
      'API Error: gateway timeout page said timeout',
    )
    expect(err.message.toLowerCase()).not.toContain('timeout')
    expect(err.diagnosticContent).toContain('timeout')
  })

  test('an exhausted retry still surfaces the diagnostic, not a generic error', () => {
    const msg = getAssistantMessageFromError(
      new EmptyFallbackRetryableError(DIAG),
      'claude-sonnet-5',
    )
    const text = JSON.stringify(msg.message.content)
    expect(text).toContain('proxy_source=pac')
    expect(text).toContain('Stream ended without receiving any events')
  })

  test('retries a connection-shaped empty fallback on every attempt', () => {
    // A dropped stream leaves no body at all: retry it.
    expect(
      shouldRetryEmptyFallback(asBetaMessage({ id: 'm', content: [] }), 1),
    ).toBe(true)
    // A non-HTML rewrite (gateway text) is still connection-shaped: retry it.
    expect(
      shouldRetryEmptyFallback(
        'upstream connect error or disconnect/reset before headers' as unknown as BetaMessage,
        9,
      ),
    ).toBe(true)
  })

  test('retries a block page a few times, then stops', () => {
    // v0.2.26 gave block pages ZERO retries, assuming a filter page is the same
    // every time. The corporate proxy disproved it: the same provider URL is
    // refused and then served within seconds. So early attempts must retry...
    expect(
      shouldRetryEmptyFallback(URL_FILTER_PAGE as unknown as BetaMessage, 1),
    ).toBe(true)
    expect(
      shouldRetryEmptyFallback(INTERCEPT_PAGE as unknown as BetaMessage, 1),
    ).toBe(true)
    // ...but a genuinely blocked host must still fail fast rather than after
    // the full ten-attempt budget.
    expect(
      shouldRetryEmptyFallback(
        URL_FILTER_PAGE as unknown as BetaMessage,
        BLOCK_PAGE_MAX_ATTEMPTS,
      ),
    ).toBe(false)
    expect(BLOCK_PAGE_MAX_ATTEMPTS).toBeLessThan(10)
  })

  test('a 407 explains proxy auth instead of "407 status code (no body)"', () => {
    // A 407 carries no body, so the default message is literally
    // "API Error: 407 status code (no body)" - it names neither the proxy nor
    // anything the user can act on.
    const msg = buildProxyAuthErrorMessage(
      { headers: headersOf('Basic realm="corp"') },
      {
        HTTPS_PROXY: 'http://proxy.corp.example:8080',
        SUPERAI_PROXY_SOURCE: 'settings',
      },
    )
    expect(msg).toContain('requires authentication (407)')
    expect(msg).toContain('proxy.corp.example:8080')
    expect(msg).toContain('Settings')
    expect(msg).toContain('proxy_source=settings')
  })

  test('a 407 demanding NTLM says so, rather than inviting a password', () => {
    const msg = buildProxyAuthErrorMessage(
      { headers: headersOf('Negotiate, NTLM') },
      { HTTPS_PROXY: 'http://proxy.corp.example:8080' },
    )
    // Telling someone to type a password into a field that cannot possibly
    // work is worse than saying plainly that we cannot do this handshake.
    expect(msg).toContain('cannot perform')
    expect(msg).toContain('ntlm')
    expect(msg).toContain('proxy_auth=negotiate,ntlm')
  })

  test('never echoes proxy credentials into the 407 message', () => {
    const msg = buildProxyAuthErrorMessage(
      { headers: headersOf('Basic') },
      { HTTPS_PROXY: 'http://alice:hunter2@proxy.corp.example:8080' },
    )
    expect(msg).not.toContain('hunter2')
    expect(msg).not.toContain('alice')
    expect(msg).toContain('REDACTED')
  })

  test('parses Proxy-Authenticate, and copes with its absence', () => {
    expect(parseProxyAuthSchemes(headersOf('NTLM'))).toEqual(['ntlm'])
    expect(parseProxyAuthSchemes(headersOf('Negotiate, NTLM, Basic'))).toEqual([
      'negotiate',
      'ntlm',
      'basic',
    ])
    // Deduped - proxies repeat schemes across multiple header lines.
    expect(parseProxyAuthSchemes(headersOf('NTLM, ntlm'))).toEqual(['ntlm'])
    expect(parseProxyAuthSchemes(headersOf())).toEqual([])
    expect(parseProxyAuthSchemes(undefined)).toEqual([])
  })

  test('still advises when the proxy sends no Proxy-Authenticate header', () => {
    const msg = buildProxyAuthErrorMessage({ headers: headersOf() }, {})
    expect(msg).toContain('requires authentication (407)')
    expect(msg).toContain('proxy_auth=unspecified')
    // No proxy configured in env - must not render an empty parenthesis.
    expect(msg).not.toContain('()')
  })

  test('the 407 branch is actually wired into the message the user sees', () => {
    // The tests above exercise the builder directly; this one proves
    // getAssistantMessageFromError routes a real 407 to it. Without this, the
    // builder could be perfect and dead - the gap I shipped twice before.
    const msg = getAssistantMessageFromError(
      new APIError(407, undefined, '407 status code (no body)', headersOf(
        'NTLM',
      ) as unknown as Headers),
      'claude-sonnet-5',
    )
    const text = JSON.stringify(msg.message.content)
    expect(text).toContain('requires authentication (407)')
    expect(text).not.toContain('no body')
  })

  test('a 407 is retried a bounded number of times, not zero and not ten', () => {
    const err = new APIError(407, undefined, 'proxy auth', undefined)
    // Zero retries was the old behaviour: an intermittently-authorising proxy
    // ended the turn on the first refusal.
    expect(shouldRetry(err, 1)).toBe(true)
    // A proxy that always demands NTLM must not burn the whole budget in
    // backoff before telling the user what is wrong.
    expect(shouldRetry(err, PROXY_AUTH_MAX_ATTEMPTS)).toBe(false)
    expect(PROXY_AUTH_MAX_ATTEMPTS).toBeLessThan(10)
    // Control: an unrelated 4xx is still not retried, so the new branch did not
    // widen retrying in general.
    expect(
      shouldRetry(new APIError(400, undefined, 'bad request', undefined), 1),
    ).toBe(false)
  })

  test('a genuine connection timeout still gets the generic message (control)', () => {
    // Proves the new branch did not hijack the pre-existing timeout handling -
    // without this, "the diagnostic survives" could be true because the new
    // branch swallowed everything.
    const msg = getAssistantMessageFromError(
      new APIConnectionTimeoutError({ message: 'Request timed out' }),
      'claude-sonnet-5',
    )
    const text = JSON.stringify(msg.message.content)
    expect(text).not.toContain('proxy_source=')
  })
})

/**
 * The route fields exist to answer "why does my colleague's identical machine
 * work" from a single screenshot: two boxes on the same LAN differ only in
 * whether their traffic goes through the sanctioned proxy.
 */
describe('describeNetworkRoute', () => {
  test('reports a direct route and where that decision came from', () => {
    expect(describeNetworkRoute({ SUPERAI_PROXY_SOURCE: 'none' })).toBe(
      'route=direct; proxy_source=none',
    )
  })

  test('reports the proxy and its source when one is in use', () => {
    expect(
      describeNetworkRoute({
        HTTPS_PROXY: 'http://proxy.corp.example:8080',
        SUPERAI_PROXY_SOURCE: 'system',
      }),
    ).toBe('route=proxy http://proxy.corp.example:8080; proxy_source=system')
  })

  test('never leaks proxy credentials into the error text', () => {
    const route = describeNetworkRoute({
      HTTPS_PROXY: 'http://alice:hunter2@proxy.corp.example:8080',
      SUPERAI_PROXY_SOURCE: 'settings',
    })
    expect(route).not.toContain('hunter2')
    expect(route).not.toContain('alice')
    expect(route).toContain('REDACTED')
    expect(route).toContain('proxy.corp.example:8080')
  })

  test('does not echo an unparseable proxy value, which may hold a password', () => {
    const route = describeNetworkRoute({ HTTPS_PROXY: 'alice:hunter2@@@' })
    expect(route).not.toContain('hunter2')
    expect(route).toContain('unparseable')
  })

  test('marks the source unknown when the desktop did not stamp one', () => {
    expect(describeNetworkRoute({})).toBe('route=direct; proxy_source=unknown')
  })

  test('the fallback error carries the route so a screenshot shows the path', () => {
    const msg = buildEmptyFallbackErrorMessage(
      '<html><head>\n<meta http-equiv="refresh" content="0;url=/block">' as unknown as BetaMessage,
      'Stream ended without receiving any events',
      undefined,
      { SUPERAI_PROXY_SOURCE: 'none' },
    )
    expect(msg).toContain('route=direct')
    expect(msg).toContain('proxy_source=none')
    expect(msg).toContain('intercepting requests')
  })
})
