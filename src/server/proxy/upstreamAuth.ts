/**
 * Upstream authentication for the proxy.
 *
 * Turns a provider's stored credentials into request headers, and — for
 * OAuth2 client-credentials providers — retries once on 401 with a fresh
 * token. Every upstream call the proxy or the "Test" button makes goes
 * through fetchUpstream(), so a bearer-key provider and an OAuth provider
 * differ in exactly one place.
 */

import { getTLSFetchOptions } from '../../utils/mtls.js'
import { getTokenSource } from '../services/oauthClientCredentials.js'
import type { ProviderAuth } from '../types/provider.js'

export type UpstreamCredentials = {
  apiKey: string
  auth?: ProviderAuth | null
}

/** Header the gateway expects the static key in when OAuth carries the bearer. */
export const API_KEY_HEADER = 'X-API-KEY'

export async function buildUpstreamHeaders(
  creds: UpstreamCredentials,
): Promise<Record<string, string>> {
  if (creds.auth?.type === 'oauth2_client_credentials') {
    const token = await getTokenSource(creds.auth).getToken()
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    }
    if (creds.apiKey) headers[API_KEY_HEADER] = creds.apiKey
    return headers
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${creds.apiKey}`,
  }
}

/**
 * Join a provider base URL with an API path without doubling `/v1`.
 *
 * OpenAI-style base URLs stop before `/v1`, but enterprise gateways hand out
 * a BASE_URL that already ends in it; pasting that verbatim used to produce
 * `/v1/v1/chat/completions` and a 404 that looked like a wrong host.
 */
export function resolveUpstreamUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  if (path.startsWith('/v1/') && /\/v1$/i.test(base)) {
    return base + path.slice('/v1'.length)
  }
  return base + path
}

export async function fetchUpstream(
  url: string,
  jsonBody: unknown,
  creds: UpstreamCredentials,
  options: { timeoutMs: number },
): Promise<Response> {
  const attempt = async () =>
    fetch(url, {
      method: 'POST',
      headers: await buildUpstreamHeaders(creds),
      body: JSON.stringify(jsonBody),
      signal: AbortSignal.timeout(options.timeoutMs),
      // Same TLS trust as the CLI: OS certificate store (corporate TLS-inspecting
      // proxies) + NODE_EXTRA_CA_CERTS. HTTPS_PROXY/NO_PROXY stay with Bun's env handling.
      ...getTLSFetchOptions(),
    })

  let response = await attempt()
  if (response.status === 401 && creds.auth?.type === 'oauth2_client_credentials') {
    // The token was revoked or expired earlier than the endpoint advertised.
    // One retry with a fresh token; a second 401 is a real rejection and is
    // returned as-is rather than looping on the token endpoint.
    getTokenSource(creds.auth).invalidate()
    response = await attempt()
  }
  return response
}
