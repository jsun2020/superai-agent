/**
 * SuperAI TUI first-run provider setup — logic behind the onboarding step
 * that replaces Claude Code's "Select login method" menu.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { hasThirdPartyAnthropicBaseUrl } from '../../utils/auth.js'
import { getCustomApiKeyStatus } from '../../utils/config.js'
import {
  activateSavedProvider,
  ANTHROPIC_OFFICIAL_BASE_URL,
  applyProviderEnv,
  approveApiKey,
  describeSetupOption,
  hasCompletedSuperaiSetup,
  listSetupOptions,
  listSetupPresets,
  markSuperaiSetupCompleted,
  saveAndActivateNewProvider,
  setupOptionId,
  shouldOfferSuperaiProviderSetup,
  superaiSetupMarkerPath,
} from '../../utils/superaiProviderSetup.js'
import { ProviderService } from '../services/providerService.js'

const MANAGED = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
]

let tmpDir: string
let savedConfigDir: string | undefined
let savedEnv: Record<string, string | undefined>

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'superai-setup-'))
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  savedEnv = {}
  for (const k of MANAGED) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(async () => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  for (const k of MANAGED) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function readJson(rel: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(tmpDir, rel), 'utf-8'))
}

describe('listSetupPresets', () => {
  test('offers every API-key preset except official (OAuth) and custom (own option)', () => {
    const ids = listSetupPresets().map(p => p.id)
    expect(ids).toEqual(['deepseek', 'zhipuglm', 'kimi', 'minimax'])
  })
})

describe('listSetupOptions', () => {
  test('with no saved providers: presets, Anthropic key, custom, then Claude login last', async () => {
    const options = await listSetupOptions()
    const ids = options.map(setupOptionId)
    expect(ids).toEqual([
      'preset:deepseek',
      'preset:zhipuglm',
      'preset:kimi',
      'preset:minimax',
      'anthropic-key',
      'custom',
      'claude-login',
    ])
  })

  test('saved providers come first; OpenAI-shaped ones are flagged as needing the desktop proxy', async () => {
    const service = new ProviderService()
    const yunwu = await service.addProvider({
      presetId: 'custom',
      name: 'Yunwu',
      apiKey: 'k1',
      baseUrl: 'https://yunwu.ai',
      apiFormat: 'anthropic',
      models: { main: 'claude-sonnet-4-6', haiku: 'h', sonnet: 's', opus: 'o' },
    })
    const responses = await service.addProvider({
      presetId: 'custom',
      name: 'Responses',
      apiKey: 'k2',
      baseUrl: 'https://api.example.com',
      apiFormat: 'openai_responses',
      models: { main: 'gpt', haiku: 'gpt', sonnet: 'gpt', opus: 'gpt' },
    })
    // A provider without a key (e.g. a half-filled entry) is not offered.
    await service.addProvider({
      presetId: 'custom',
      name: 'NoKey',
      apiKey: '',
      baseUrl: 'https://nokey.example.com',
      apiFormat: 'anthropic',
      models: { main: 'm', haiku: 'm', sonnet: 'm', opus: 'm' },
    })

    const options = await listSetupOptions(service)
    expect(options[0]).toMatchObject({ kind: 'saved', needsDesktopProxy: false })
    expect(setupOptionId(options[0]!)).toBe(`saved:${yunwu.id}`)
    expect(options[1]).toMatchObject({ kind: 'saved', needsDesktopProxy: true })
    expect(setupOptionId(options[1]!)).toBe(`saved:${responses.id}`)
    expect(describeSetupOption(options[1]!)).toContain('needs the SuperAI desktop proxy')
    expect(describeSetupOption(options[0]!)).toBe('yunwu.ai · claude-sonnet-4-6')
    expect(options.filter(o => o.kind === 'saved')).toHaveLength(2)
    expect(setupOptionId(options[options.length - 1]!)).toBe('claude-login')
  })
})

describe('saveAndActivateNewProvider', () => {
  test('writes the same files the desktop uses and applies the env to this process', async () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'stale-from-previous-provider'

    const { provider, env } = await saveAndActivateNewProvider({
      presetId: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/anthropic/',
      apiKey: 'sk-test-deepseek',
      model: 'deepseek-chat',
    })

    // providers.json: saved + active
    const index = (await readJson('superai/providers.json')) as {
      activeId: string
      providers: Array<{ id: string; baseUrl: string; apiFormat: string }>
    }
    expect(index.activeId).toBe(provider.id)
    expect(index.providers[0]!.baseUrl).toBe('https://api.deepseek.com/anthropic')
    expect(index.providers[0]!.apiFormat).toBe('anthropic')

    // settings.json env: what managedEnv applies on the next start
    const settings = (await readJson('superai/settings.json')) as { env: Record<string, string> }
    expect(settings.env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic')
    expect(settings.env.ANTHROPIC_API_KEY).toBe('sk-test-deepseek')
    expect(settings.env.ANTHROPIC_MODEL).toBe('deepseek-chat')
    expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('deepseek-chat')

    // process.env: what this session uses right now
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic')
    expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic')
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-test-deepseek')
    expect(process.env.ANTHROPIC_MODEL).toBe('deepseek-chat')
    expect(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('deepseek-chat')
  })

  test('a blank model leaves the model env vars unset (client default), never empty strings', async () => {
    await saveAndActivateNewProvider({
      presetId: 'custom',
      name: 'Anthropic',
      baseUrl: ANTHROPIC_OFFICIAL_BASE_URL,
      apiKey: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
      model: '',
    })
    expect(process.env.ANTHROPIC_BASE_URL).toBe(ANTHROPIC_OFFICIAL_BASE_URL)
    expect(process.env.ANTHROPIC_MODEL).toBeUndefined()
    expect(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined()
  })
})

describe('approveApiKey', () => {
  test('records the typed key as approved so the "Detected a custom API key" dialog does not re-ask', () => {
    const key = 'sk-ant-api03-0123456789abcdefghijklmnop'
    expect(getCustomApiKeyStatus(key.slice(-20))).toBe('new')
    approveApiKey(key)
    expect(getCustomApiKeyStatus(key.slice(-20))).toBe('approved')
  })

  test('saving a third-party provider approves its key too (showSetupScreens gates every ANTHROPIC_API_KEY)', async () => {
    const key = 'sk-third-party-zzzzzzzzzzzzzzzzzzzz'
    expect(getCustomApiKeyStatus(key.slice(-20))).toBe('new')
    await saveAndActivateNewProvider({
      presetId: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: key,
      model: 'deepseek-chat',
    })
    expect(getCustomApiKeyStatus(key.slice(-20))).toBe('approved')
  })
})

describe('activateSavedProvider', () => {
  test('makes a saved provider active and applies its env', async () => {
    const service = new ProviderService()
    const p = await service.addProvider({
      presetId: 'kimi',
      name: 'Kimi',
      apiKey: 'sk-kimi',
      baseUrl: 'https://api.moonshot.cn/anthropic',
      apiFormat: 'anthropic',
      models: { main: 'kimi-k2.6', haiku: 'kimi-k2.6', sonnet: 'kimi-k2.6', opus: 'kimi-k2.6' },
    })
    const env = await activateSavedProvider(p.id, service)
    expect(env.ANTHROPIC_API_KEY).toBe('sk-kimi')
    expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.cn/anthropic')
    const index = (await readJson('superai/providers.json')) as { activeId: string }
    expect(index.activeId).toBe(p.id)
  })
})

describe('applyProviderEnv', () => {
  test('clears every managed key before applying, and skips empty values', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'old-token'
    applyProviderEnv({ ANTHROPIC_BASE_URL: 'https://x.example', ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: '' })
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(process.env.ANTHROPIC_BASE_URL).toBe('https://x.example')
    expect(process.env.ANTHROPIC_MODEL).toBeUndefined()
  })
})

describe("once-per-machine gate (independent of Claude Code's hasCompletedOnboarding)", () => {
  test('offered on a machine that only has a Claude.ai login, then never again once marked', () => {
    delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
    // A Claude login and no SuperAI provider: exactly the case where the TUI
    // used to run silently on the Claude account.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth-token'
    try {
      expect(hasCompletedSuperaiSetup()).toBe(false)
      expect(shouldOfferSuperaiProviderSetup()).toBe(true)
      markSuperaiSetupCompleted('claude-account')
      expect(hasCompletedSuperaiSetup()).toBe(true)
      expect(shouldOfferSuperaiProviderSetup()).toBe(false)
    } finally {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    }
    const marker = JSON.parse(readFileSync(superaiSetupMarkerPath(), 'utf-8')) as { choice: string }
    expect(marker.choice).toBe('claude-account')
    expect(path.normalize(superaiSetupMarkerPath())).toBe(path.join(tmpDir, 'superai', 'tui-setup.json'))
  })

  test('not offered when the desktop host owns the provider env', () => {
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    try {
      expect(shouldOfferSuperaiProviderSetup()).toBe(false)
    } finally {
      delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
    }
  })

  test('not offered when an external key already routes to a third-party endpoint', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
    process.env.ANTHROPIC_API_KEY = 'sk-external'
    expect(shouldOfferSuperaiProviderSetup()).toBe(false)
  })

  test('the Claude option carries no account name when no Claude.ai login exists here', async () => {
    const options = await listSetupOptions()
    const claude = options[options.length - 1]!
    expect(claude).toEqual({ kind: 'claude-login', loggedInAs: null })
    expect(describeSetupOption(claude)).toBe('Claude subscription, Console, or Bedrock / Foundry / Vertex')
    expect(describeSetupOption({ kind: 'claude-login', loggedInAs: 'Claude Max' })).toBe(
      'keep using the Claude Max account already signed in on this machine',
    )
  })
})

describe('hasThirdPartyAnthropicBaseUrl (silences the "auth conflict" notice for a SuperAI provider)', () => {
  test('third-party host -> true; Anthropic hosts, unset or malformed -> false', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.minimaxi.com/anthropic'
    expect(hasThirdPartyAnthropicBaseUrl()).toBe(true)
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
    expect(hasThirdPartyAnthropicBaseUrl()).toBe(false)
    process.env.ANTHROPIC_BASE_URL = 'https://eu.api.anthropic.com/v1'
    expect(hasThirdPartyAnthropicBaseUrl()).toBe(false)
    process.env.ANTHROPIC_BASE_URL = 'not a url'
    expect(hasThirdPartyAnthropicBaseUrl()).toBe(false)
    delete process.env.ANTHROPIC_BASE_URL
    expect(hasThirdPartyAnthropicBaseUrl()).toBe(false)
  })
})
