// desktop/src/types/provider.ts

export type ApiFormat = 'anthropic' | 'openai_chat' | 'openai_responses'

export type ModelMapping = {
  main: string
  haiku: string
  sonnet: string
  opus: string
}

/**
 * OAuth2 client-credentials auth for enterprise gateways. The proxy fetches a
 * bearer token from `tokenUrl` and sends the provider's apiKey as X-API-KEY.
 * Only valid with a proxied (openai_*) apiFormat.
 */
export type ProviderAuth = {
  type: 'oauth2_client_credentials'
  tokenUrl: string
  clientId: string
  clientSecret: string  // masked from server; blank on update keeps current
  scope?: string
}

export type SavedProvider = {
  id: string
  presetId: string
  name: string
  apiKey: string  // masked from server
  baseUrl: string
  apiFormat: ApiFormat
  models: ModelMapping
  notes?: string
  auth?: ProviderAuth
}

export type CreateProviderInput = {
  presetId: string
  name: string
  apiKey: string
  baseUrl: string
  apiFormat?: ApiFormat
  models: ModelMapping
  notes?: string
  auth?: ProviderAuth
}

export type UpdateProviderInput = {
  name?: string
  apiKey?: string
  baseUrl?: string
  apiFormat?: ApiFormat
  models?: ModelMapping
  notes?: string
  /** `null` removes OAuth (back to a plain bearer key); undefined leaves it. */
  auth?: ProviderAuth | null
}

export type TestProviderConfigInput = {
  baseUrl: string
  apiKey: string
  modelId: string
  apiFormat?: ApiFormat
  auth?: ProviderAuth
}

/** Overrides for testing a SAVED provider with edited-but-unsaved fields. */
export type TestProviderOverrides = {
  baseUrl?: string
  modelId?: string
  apiFormat?: ApiFormat
  /** Partial: a blank clientSecret tests with the stored one. `null` tests as bearer. */
  auth?: (Partial<ProviderAuth> & { type: 'oauth2_client_credentials' }) | null
}

export type ProviderTestStepResult = {
  success: boolean
  latencyMs: number
  error?: string
  modelUsed?: string
  httpStatus?: number
}

export type ProviderTestResult = {
  /** Step 1: Basic connectivity */
  connectivity: ProviderTestStepResult
  /** Step 2: Proxy pipeline (only for openai_* formats) */
  proxy?: ProviderTestStepResult
}
