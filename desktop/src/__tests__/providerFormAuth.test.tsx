/**
 * "Add Provider" form: the OAuth2 client-credentials authentication mode.
 *
 * Same mocked-store harness as generalSettings.test.tsx. The assertions are
 * about what the form shows and what it sends - the server side is covered
 * by src/server/__tests__/providersAuth.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { Settings } from '../pages/Settings'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useUpdateStore } from '../stores/updateStore'
import type { CreateProviderInput, SavedProvider } from '../types/provider'
import type { ProviderPreset } from '../types/providerPreset'

const CUSTOM_PRESET: ProviderPreset = {
  id: 'custom',
  name: 'Custom',
  baseUrl: '',
  apiFormat: 'anthropic',
  defaultModels: { main: '', haiku: '', sonnet: '', opus: '' },
  needsApiKey: true,
  websiteUrl: '',
}

const providerStoreState = {
  providers: [] as SavedProvider[],
  activeId: null as string | null,
  presets: [CUSTOM_PRESET] as ProviderPreset[],
  isLoading: false,
  isPresetsLoading: false,
  fetchProviders: vi.fn(),
  fetchPresets: vi.fn(),
  deleteProvider: vi.fn(),
  activateProvider: vi.fn(),
  activateOfficial: vi.fn(),
  testProvider: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  testConfig: vi.fn(),
}

vi.mock('../api/agents', () => ({
  agentsApi: { list: vi.fn().mockResolvedValue({ activeAgents: [], allAgents: [] }) },
}))

vi.mock('../api/providers', () => ({
  providersApi: {
    getSettings: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn().mockResolvedValue({ ok: true }),
  },
}))

vi.mock('../stores/providerStore', () => ({
  useProviderStore: Object.assign(() => providerStoreState, { getState: () => providerStoreState }),
}))

vi.mock('../pages/AdapterSettings', () => ({ AdapterSettings: () => <div /> }))
vi.mock('../stores/agentStore', () => ({
  useAgentStore: () => ({ activeAgents: [], allAgents: [], isLoading: false, error: null, selectedAgent: null, fetchAgents: vi.fn(), selectAgent: vi.fn() }),
}))
vi.mock('../stores/skillStore', () => ({
  useSkillStore: () => ({ skills: [], selectedSkill: null, isLoading: false, isDetailLoading: false, error: null, fetchSkills: vi.fn(), fetchSkillDetail: vi.fn(), clearSelection: vi.fn() }),
}))
vi.mock('../components/chat/CodeViewer', () => ({ CodeViewer: () => <pre /> }))

function openCustomForm() {
  render(<Settings />)
  fireEvent.click(screen.getByText('Add Provider'))
}

function setSelect(displayValue: string, value: string) {
  fireEvent.change(screen.getByDisplayValue(displayValue), { target: { value } })
}

function type(labelPattern: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(labelPattern), { target: { value } })
}

describe('Add Provider > Custom > Authentication', () => {
  beforeEach(() => {
    providerStoreState.providers = []
    providerStoreState.activeId = null
    providerStoreState.presets = [CUSTOM_PRESET]
    providerStoreState.createProvider = vi.fn().mockResolvedValue(undefined)
    providerStoreState.updateProvider = vi.fn().mockResolvedValue(undefined)
    providerStoreState.testConfig = vi.fn()
    providerStoreState.testProvider = vi.fn()

    useSettingsStore.setState({ locale: 'en', fetchAll: vi.fn().mockResolvedValue(undefined) } as never)
    useUIStore.setState({ pendingSettingsTab: null })
    useUpdateStore.setState({
      status: 'idle', availableVersion: null, releaseNotes: null, progressPercent: 0,
      downloadedBytes: 0, totalBytes: null, error: null, checkedAt: null, shouldPrompt: false,
      initialize: vi.fn().mockResolvedValue(undefined), checkForUpdates: vi.fn().mockResolvedValue(null),
      installUpdate: vi.fn().mockResolvedValue(undefined), dismissPrompt: vi.fn(),
    })
  })

  it('hides authentication for native Anthropic - the CLI calls it directly', () => {
    openCustomForm()
    expect(screen.queryByLabelText('Authentication')).not.toBeInTheDocument()
    expect(screen.getByLabelText(/^API Key/)).toBeInTheDocument()
  })

  it('offers OAuth2 once the format routes through the proxy, and shows its fields only when chosen', () => {
    openCustomForm()
    setSelect('Anthropic Messages (native)', 'openai_chat')

    const auth = screen.getByLabelText('Authentication')
    expect(auth).toHaveValue('bearer')
    expect(screen.queryByLabelText(/Token URL/)).not.toBeInTheDocument()

    fireEvent.change(auth, { target: { value: 'oauth2' } })
    expect(screen.getByLabelText(/Token URL/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Client ID/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Client Secret/)).toBeInTheDocument()
    // The key field is the same field, relabelled for what the gateway calls it.
    expect(screen.getByLabelText(/^X-API-KEY/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/^API Key/)).not.toBeInTheDocument()
  })

  it('drops back to bearer when the format returns to native Anthropic', () => {
    openCustomForm()
    setSelect('Anthropic Messages (native)', 'openai_chat')
    fireEvent.change(screen.getByLabelText('Authentication'), { target: { value: 'oauth2' } })
    expect(screen.getByLabelText(/Token URL/)).toBeInTheDocument()

    setSelect('OpenAI Chat Completions (proxy)', 'anthropic')
    expect(screen.queryByLabelText('Authentication')).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Token URL/)).not.toBeInTheDocument()
    expect(screen.getByLabelText(/^API Key/)).toBeInTheDocument()
  })

  it('will not submit an OAuth provider until the token URL, client ID and secret are present', () => {
    openCustomForm()
    setSelect('Anthropic Messages (native)', 'openai_chat')
    fireEvent.change(screen.getByLabelText('Authentication'), { target: { value: 'oauth2' } })

    type(/^Name/, 'Corp gateway')
    type(/^Base URL/, 'http://gateway.corp.example/svc/v1')
    type(/^X-API-KEY/, 'x-key')
    type(/^Main Model/, 'corp-model')
    const add = screen.getByRole('button', { name: 'Add' })
    expect(add).toBeDisabled()

    type(/Token URL/, 'http://gateway.corp.example/oauth2/token')
    type(/^Client ID/, 'cid')
    expect(add).toBeDisabled()
    type(/^Client Secret/, 'csec')
    expect(add).toBeEnabled()
  })

  it('sends the auth block with the five gateway parameters', async () => {
    openCustomForm()
    setSelect('Anthropic Messages (native)', 'openai_chat')
    fireEvent.change(screen.getByLabelText('Authentication'), { target: { value: 'oauth2' } })

    type(/^Name/, 'Corp gateway')
    type(/^Base URL/, 'http://gateway.corp.example/svc/v1')
    type(/^X-API-KEY/, 'x-key')
    type(/^Main Model/, 'corp-model')
    type(/Token URL/, 'http://gateway.corp.example/oauth2/token')
    type(/^Client ID/, 'cid')
    type(/^Client Secret/, 'csec')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await vi.waitFor(() => expect(providerStoreState.createProvider).toHaveBeenCalledTimes(1))
    const sent = providerStoreState.createProvider.mock.calls[0]![0] as CreateProviderInput
    expect(sent.apiFormat).toBe('openai_chat')
    expect(sent.baseUrl).toBe('http://gateway.corp.example/svc/v1')
    expect(sent.apiKey).toBe('x-key')
    expect(sent.auth).toEqual({
      type: 'oauth2_client_credentials',
      tokenUrl: 'http://gateway.corp.example/oauth2/token',
      clientId: 'cid',
      clientSecret: 'csec',
    })
  })

  it('sends no auth block for a plain bearer provider - existing behaviour unchanged', async () => {
    openCustomForm()
    setSelect('Anthropic Messages (native)', 'openai_chat')

    type(/^Name/, 'Plain')
    type(/^Base URL/, 'https://api.example.com')
    type(/^API Key/, 'sk-1')
    type(/^Main Model/, 'm')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await vi.waitFor(() => expect(providerStoreState.createProvider).toHaveBeenCalledTimes(1))
    const sent = providerStoreState.createProvider.mock.calls[0]![0] as CreateProviderInput
    expect('auth' in sent).toBe(false)
  })
})
