/**
 * SuperAI TUI first-run provider setup — logic behind the onboarding step
 * that replaces Claude Code's "Select login method" menu.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { getCustomApiKeyStatus } from '../../utils/config.js'
import {
  activateSavedProvider,
  ANTHROPIC_OFFICIAL_BASE_URL,
  applyProviderEnv,
  approveApiKey,
  describeSetupOption,
  listSetupOptions,
  listSetupPresets,
  saveAndActivateNewProvider,
  setupOptionId,
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
