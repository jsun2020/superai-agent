/**
 * SuperAI first-run provider setup — the logic behind the TUI's
 * `SuperaiProviderSetup` onboarding step.
 *
 * The desktop app configures model providers through ProviderService
 * (~/.claude/superai/providers.json + ~/.claude/superai/settings.json env,
 * applied on every start by managedEnv.applySafeConfigEnvironmentVariables).
 * The standalone TUI had no writer for that store, so a machine without a
 * Claude.ai login could only ever reach Claude Code's own login menu. This
 * module gives the TUI the same "base URL + API key" path, writing the exact
 * same files so the desktop and the TUI always agree on the active provider.
 */

import { PROVIDER_PRESETS, type ProviderPreset } from '../server/config/providerPresets.js'
import { ProviderService } from '../server/services/providerService.js'
import type {
  ProviderTestResult,
  SavedProvider,
} from '../server/types/provider.js'
import { normalizeApiKeyForConfig } from './authPortable.js'
import { saveGlobalConfig } from './config.js'
import { getDefaultSonnetModel } from './model/model.js'

/** Base URL used for the "Anthropic API key" option. */
export const ANTHROPIC_OFFICIAL_BASE_URL = 'https://api.anthropic.com'

export type SetupOption =
  | { kind: 'saved'; provider: SavedProvider; needsDesktopProxy: boolean }
  | { kind: 'preset'; preset: ProviderPreset }
  | { kind: 'anthropic-key' }
  | { kind: 'custom' }
  | { kind: 'claude-login' }

/** Stable string ids for Select values. */
export function setupOptionId(option: SetupOption): string {
  switch (option.kind) {
    case 'saved':
      return `saved:${option.provider.id}`
    case 'preset':
      return `preset:${option.preset.id}`
    default:
      return option.kind
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** One-line description shown next to an option. */
export function describeSetupOption(option: SetupOption): string {
  switch (option.kind) {
    case 'saved':
      return option.needsDesktopProxy
        ? `${hostOf(option.provider.baseUrl)} · ${option.provider.apiFormat} — needs the SuperAI desktop proxy`
        : `${hostOf(option.provider.baseUrl)} · ${option.provider.models.main}`
    case 'preset':
      return `${hostOf(option.preset.baseUrl)} · ${option.preset.defaultModels.main}`
    case 'anthropic-key':
      return 'api.anthropic.com · Console API key'
    case 'custom':
      return 'any Anthropic-compatible base URL + API key'
    case 'claude-login':
      return 'Claude subscription, Console, or Bedrock / Foundry / Vertex'
  }
}

/**
 * Presets the TUI can offer: everything that takes an API key except the
 * free-form `custom` (rendered as its own option) and `official` (OAuth,
 * i.e. the Claude login option).
 */
export function listSetupPresets(presets: ProviderPreset[] = PROVIDER_PRESETS): ProviderPreset[] {
  return presets.filter(p => p.needsApiKey && p.id !== 'custom' && p.id !== 'official' && p.baseUrl)
}

/**
 * Build the option list in display order: saved providers first (a returning
 * user just picks one), then presets, then the two free-form paths, then the
 * original Claude Code login as an escape hatch.
 *
 * Saved providers with an OpenAI-shaped API are listed but flagged: their
 * traffic goes through the desktop sidecar's translating proxy, which is not
 * running when the TUI is launched on its own.
 */
export async function listSetupOptions(
  service: ProviderService = new ProviderService(),
): Promise<SetupOption[]> {
  const options: SetupOption[] = []
  let saved: SavedProvider[] = []
  try {
    saved = (await service.listProviders()).providers
  } catch {
    saved = []
  }
  for (const provider of saved) {
    if (!provider.apiKey || !provider.baseUrl) continue
    options.push({
      kind: 'saved',
      provider,
      needsDesktopProxy: provider.apiFormat !== 'anthropic',
    })
  }
  for (const preset of listSetupPresets()) {
    options.push({ kind: 'preset', preset })
  }
  options.push({ kind: 'anthropic-key' })
  options.push({ kind: 'custom' })
  options.push({ kind: 'claude-login' })
  return options
}

export type NewProviderInput = {
  presetId: string
  name: string
  baseUrl: string
  apiKey: string
  /** Main model id; empty means "let the client pick its default". */
  model: string
}

/** Env keys ProviderService manages; cleared before applying a new provider. */
const MANAGED_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
] as const

/**
 * Put a provider's env into the running process so the session that just
 * completed onboarding works immediately (the persisted settings.json only
 * takes effect on the next start). Stale managed keys are removed first so a
 * previous provider's model defaults cannot bleed into the new one.
 */
export function applyProviderEnv(env: Record<string, string>): void {
  for (const key of MANAGED_ENV_KEYS) {
    delete process.env[key]
  }
  for (const [key, value] of Object.entries(env)) {
    if (value) process.env[key] = value
  }
}

/**
 * Claude Code guards an ANTHROPIC_API_KEY found in the environment with the
 * "Detected a custom API key — do you want to use it? (No recommended)"
 * dialog (customApiKeyResponses, shown by showSetupScreens right after this
 * step, and consulted by the auth path on api.anthropic.com). The user just
 * typed this key in on purpose — record it as approved, exactly as answering
 * "Yes" in that dialog would, so it is not asked again a second later.
 */
export function approveApiKey(apiKey: string): void {
  if (!apiKey) return
  const truncated = normalizeApiKeyForConfig(apiKey)
  saveGlobalConfig(current => {
    const approved = current.customApiKeyResponses?.approved ?? []
    if (approved.includes(truncated)) return current
    return {
      ...current,
      customApiKeyResponses: {
        ...current.customApiKeyResponses,
        approved: [...approved, truncated],
      },
    }
  })
}

/**
 * Persist a new provider, make it the active one (writes settings.json env
 * the same way the desktop does) and apply its env to this process.
 * Returns the saved provider and the env that is now in effect.
 */
export async function saveAndActivateNewProvider(
  input: NewProviderInput,
  service: ProviderService = new ProviderService(),
): Promise<{ provider: SavedProvider; env: Record<string, string> }> {
  const model = input.model.trim()
  const provider = await service.addProvider({
    presetId: input.presetId,
    name: input.name.trim(),
    apiKey: input.apiKey.trim(),
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
    apiFormat: 'anthropic',
    models: { main: model, haiku: model, sonnet: model, opus: model },
  })
  await service.activateProvider(provider.id)
  const env = await service.getProviderRuntimeEnv(provider.id)
  approveApiKey(provider.apiKey)
  applyProviderEnv(env)
  return { provider, env }
}

/** Activate an already-saved provider and apply its env to this process. */
export async function activateSavedProvider(
  id: string,
  service: ProviderService = new ProviderService(),
): Promise<Record<string, string>> {
  await service.activateProvider(id)
  const provider = await service.getProvider(id)
  const env = await service.getProviderRuntimeEnv(provider.id)
  approveApiKey(provider.apiKey)
  applyProviderEnv(env)
  return env
}

/**
 * One real request against the endpoint (30s timeout) — the same check the
 * desktop's "Test connection" runs. A blank model (the Anthropic-key option
 * leaves the model to the client) is probed with the client's default Sonnet.
 */
export async function testProviderConnectivity(
  input: { baseUrl: string; apiKey: string; model: string },
  service: ProviderService = new ProviderService(),
): Promise<ProviderTestResult> {
  return service.testProviderConfig({
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: input.apiKey.trim(),
    modelId: input.model.trim() || getDefaultSonnetModel(),
    apiFormat: 'anthropic',
  })
}
