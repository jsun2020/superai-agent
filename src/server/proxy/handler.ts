/**
 * Proxy Handler — protocol-translating reverse proxy for OpenAI-compatible APIs.
 *
 * Receives Anthropic Messages API requests from the CLI, transforms them to
 * OpenAI Chat Completions or Responses API format, forwards to the upstream
 * provider, and transforms the response back to Anthropic format.
 *
 * Derived from cc-switch (https://github.com/farion1231/cc-switch)
 * Original work by Jason Young, MIT License
 */

import { ProviderService } from '../services/providerService.js'
import {
  fetchUpstream,
  resolveUpstreamUrl,
  type UpstreamCredentials,
  type UpstreamTimeouts,
} from './upstreamAuth.js'
import {
  isMaxTokensRejection,
  maxTokensAccepted,
  rememberMaxTokensRejected,
  stripMaxTokens,
} from './maxTokensPolicy.js'
import { anthropicToOpenaiChat } from './transform/anthropicToOpenaiChat.js'
import { anthropicToOpenaiResponses } from './transform/anthropicToOpenaiResponses.js'
import { openaiChatToAnthropic } from './transform/openaiChatToAnthropic.js'
import { openaiResponsesToAnthropic } from './transform/openaiResponsesToAnthropic.js'
import { openaiChatStreamToAnthropic } from './streaming/openaiChatStreamToAnthropic.js'
import { openaiResponsesStreamToAnthropic } from './streaming/openaiResponsesStreamToAnthropic.js'
import type { AnthropicRequest } from './transform/types.js'

const providerService = new ProviderService()

export async function handleProxyRequest(req: Request, url: URL): Promise<Response> {
  const providerMatch = url.pathname.match(/^\/proxy\/providers\/([^/]+)\/v1\/messages$/)
  const providerId = providerMatch ? decodeURIComponent(providerMatch[1]!) : undefined
  const isActiveProxyPath = url.pathname === '/proxy/v1/messages'

  // Only handle POST /proxy/v1/messages or POST /proxy/providers/:providerId/v1/messages
  if (req.method !== 'POST' || (!isActiveProxyPath && !providerMatch)) {
    return Response.json(
      {
        error: 'Not Found',
        message: 'Proxy only handles POST /proxy/v1/messages and POST /proxy/providers/:providerId/v1/messages',
      },
      { status: 404 },
    )
  }

  // Read active/default provider config or an explicitly-scoped provider config.
  const config = await providerService.getProviderForProxy(providerId)
  if (!config) {
    return Response.json(
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: providerId
            ? `Provider "${providerId}" is not configured for proxy`
            : 'No active provider configured for proxy',
        },
      },
      { status: 400 },
    )
  }

  if (config.apiFormat === 'anthropic') {
    return Response.json(
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: providerId
            ? `Provider "${providerId}" uses anthropic format — proxy not needed`
            : 'Active provider uses anthropic format — proxy not needed',
        },
      },
      { status: 400 },
    )
  }

  // Parse request body
  let body: AnthropicRequest
  try {
    body = (await req.json()) as AnthropicRequest
  } catch {
    return Response.json(
      { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON in request body' } },
      { status: 400 },
    )
  }

  const isStream = body.stream === true
  const baseUrl = config.baseUrl.replace(/\/+$/, '')
  const creds: UpstreamCredentials = { apiKey: config.apiKey, auth: config.auth }

  try {
    if (config.apiFormat === 'openai_chat') {
      return await handleOpenaiChat(body, baseUrl, creds, isStream)
    } else {
      return await handleOpenaiResponses(body, baseUrl, creds, isStream)
    }
  } catch (err) {
    console.error('[Proxy] Upstream request failed:', err)
    return Response.json(
      {
        type: 'error',
        error: {
          type: 'api_error',
          message: err instanceof Error ? err.message : String(err),
        },
      },
      { status: 502 },
    )
  }
}

/**
 * Streaming: bound only the wait for headers. The body is the model talking,
 * which legitimately takes minutes; a whole-body cap here truncated streams at
 * 30s, the CLI discarded the partial text and re-requested non-streaming, and
 * users saw nothing for 30s and then a late answer.
 * Non-streaming: headers arrive only when generation is done, so the total
 * budget applies to both.
 */
function upstreamTimeouts(isStream: boolean): UpstreamTimeouts {
  return isStream
    ? { headersTimeoutMs: 60_000 }
    : { headersTimeoutMs: 300_000, totalTimeoutMs: 300_000 }
}

/**
 * Send the transformed request, forwarding the CLI's max_tokens unless this
 * provider is known to reject it. A first-time rejection (400 naming the
 * field) is retried once without it and remembered - see maxTokensPolicy.ts.
 */
async function sendUpstream(
  url: string,
  baseUrl: string,
  transformed: Record<string, unknown>,
  creds: UpstreamCredentials,
  isStream: boolean,
): Promise<Response> {
  const timeouts = upstreamTimeouts(isStream)
  if (!maxTokensAccepted(baseUrl)) {
    return fetchUpstream(url, stripMaxTokens(transformed), creds, timeouts)
  }
  const first = await fetchUpstream(url, transformed, creds, timeouts)
  if (first.status !== 400) return first

  const text = await first.text().catch(() => '')
  if (!isMaxTokensRejection(first.status, text)) {
    // A different 400: hand it back intact for the normal error path.
    return new Response(text, { status: first.status, headers: first.headers })
  }
  rememberMaxTokensRejected(baseUrl)
  console.warn(
    `[Proxy] ${baseUrl} rejected max_tokens (${text.slice(0, 120)}); retrying without it and omitting it for this provider from now on. Long answers may be cut at the provider's own default cap.`,
  )
  return fetchUpstream(url, stripMaxTokens(transformed), creds, timeouts)
}

async function handleOpenaiChat(
  body: AnthropicRequest,
  baseUrl: string,
  creds: UpstreamCredentials,
  isStream: boolean,
): Promise<Response> {
  const transformed = anthropicToOpenaiChat(body) as unknown as Record<string, unknown>
  const url = resolveUpstreamUrl(baseUrl, '/v1/chat/completions')

  const upstream = await sendUpstream(url, baseUrl, transformed, creds, isStream)

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '')
    return Response.json(
      {
        type: 'error',
        error: {
          type: 'api_error',
          message: `Upstream returned HTTP ${upstream.status}: ${errText.slice(0, 500)}`,
        },
      },
      { status: upstream.status },
    )
  }

  if (isStream) {
    if (!upstream.body) {
      return Response.json(
        { type: 'error', error: { type: 'api_error', message: 'Upstream returned no body for stream' } },
        { status: 502 },
      )
    }
    const anthropicStream = openaiChatStreamToAnthropic(upstream.body, body.model)
    return new Response(anthropicStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }

  // Non-streaming
  const responseBody = await upstream.json()
  const anthropicResponse = openaiChatToAnthropic(responseBody, body.model)
  return Response.json(anthropicResponse)
}

async function handleOpenaiResponses(
  body: AnthropicRequest,
  baseUrl: string,
  creds: UpstreamCredentials,
  isStream: boolean,
): Promise<Response> {
  const transformed = anthropicToOpenaiResponses(body) as unknown as Record<string, unknown>
  const url = resolveUpstreamUrl(baseUrl, '/v1/responses')

  const upstream = await sendUpstream(url, baseUrl, transformed, creds, isStream)

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '')
    return Response.json(
      {
        type: 'error',
        error: {
          type: 'api_error',
          message: `Upstream returned HTTP ${upstream.status}: ${errText.slice(0, 500)}`,
        },
      },
      { status: upstream.status },
    )
  }

  if (isStream) {
    if (!upstream.body) {
      return Response.json(
        { type: 'error', error: { type: 'api_error', message: 'Upstream returned no body for stream' } },
        { status: 502 },
      )
    }
    const anthropicStream = openaiResponsesStreamToAnthropic(upstream.body, body.model)
    return new Response(anthropicStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }

  // Non-streaming
  const responseBody = await upstream.json()
  const anthropicResponse = openaiResponsesToAnthropic(responseBody, body.model)
  return Response.json(anthropicResponse)
}
