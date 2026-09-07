/**
 * Provider types — preset-based provider configuration.
 *
 * Providers are stored in ~/.claude/superai/providers.json as a lightweight index.
 * The active provider's env vars are written to ~/.claude/settings.json.
 */

import { z } from 'zod'

export const ApiFormatSchema = z.enum([
  'anthropic',         // Native Anthropic Messages API (passthrough, no proxy)
  'openai_chat',       // OpenAI Chat Completions /v1/chat/completions
  'openai_responses',  // OpenAI Responses API /v1/responses
])
export type ApiFormat = z.infer<typeof ApiFormatSchema>

export const ModelMappingSchema = z.object({
  main: z.string(),
  haiku: z.string(),
  sonnet: z.string(),
  opus: z.string(),
})

/**
 * Upstream authentication beyond a plain bearer key.
 *
 * `oauth2_client_credentials`: the proxy POSTs `grant_type=client_credentials`
 * to `tokenUrl`, sends the resulting token as `Authorization: Bearer`, and
 * sends the provider's `apiKey` as `X-API-KEY`. This is the shape enterprise
 * API gateways commonly use. Only meaningful for proxied formats — a native
 * Anthropic provider is called by the CLI directly, which cannot do the dance.
 */
export const ProviderAuthSchema = z.object({
  type: z.literal('oauth2_client_credentials'),
  tokenUrl: z.string().min(1),
  clientId: z.string().min(1),
  // Empty on update means "keep the stored secret", mirroring apiKey.
  clientSecret: z.string(),
  scope: z.string().optional(),
})
export type ProviderAuth = z.infer<typeof ProviderAuthSchema>

export const SavedProviderSchema = z.object({
  id: z.string(),
  presetId: z.string(),
  name: z.string().min(1),
  apiKey: z.string(),
  baseUrl: z.string(),
  apiFormat: ApiFormatSchema.default('anthropic'),
  models: ModelMappingSchema,
  notes: z.string().optional(),
  auth: ProviderAuthSchema.optional(),
})

export const ProvidersIndexSchema = z.object({
  activeId: z.string().nullable(),
  providers: z.array(SavedProviderSchema),
})

export const CreateProviderSchema = z.object({
  presetId: z.string().min(1),
  name: z.string().min(1),
  apiKey: z.string(),
  baseUrl: z.string(),
  apiFormat: ApiFormatSchema.default('anthropic'),
  models: ModelMappingSchema,
  notes: z.string().optional(),
  auth: ProviderAuthSchema.optional(),
})

export const UpdateProviderSchema = z.object({
  name: z.string().min(1).optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  apiFormat: ApiFormatSchema.optional(),
  models: ModelMappingSchema.optional(),
  notes: z.string().optional(),
  // `null` removes the block (back to a plain bearer key); undefined leaves it.
  auth: ProviderAuthSchema.nullable().optional(),
})

export const TestProviderSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  modelId: z.string().min(1),
  apiFormat: ApiFormatSchema.default('anthropic'),
  auth: ProviderAuthSchema.optional(),
})

// TypeScript types
export type ModelMapping = z.infer<typeof ModelMappingSchema>
export type SavedProvider = z.infer<typeof SavedProviderSchema>
export type ProvidersIndex = z.infer<typeof ProvidersIndexSchema>
export type CreateProviderInput = z.infer<typeof CreateProviderSchema>
export type UpdateProviderInput = z.infer<typeof UpdateProviderSchema>
export type TestProviderInput = z.infer<typeof TestProviderSchema>

export interface ProviderTestStepResult {
  success: boolean
  latencyMs: number
  error?: string
  modelUsed?: string
  httpStatus?: number
}

export interface ProviderTestResult {
  /** Step 1: Basic connectivity — API reachable, key valid, model exists */
  connectivity: ProviderTestStepResult
  /** Step 2: Proxy pipeline — full Anthropic→OpenAI→Anthropic round-trip (only for openai_* formats) */
  proxy?: ProviderTestStepResult
}
