/**
 * SuperAI first-run provider setup — the onboarding step shown where Claude
 * Code would show its "Select login method" menu.
 *
 * SuperAI Agent talks to any Anthropic-compatible endpoint through the same
 * provider store the desktop app manages (~/.claude/superai/providers.json +
 * settings.json env). This step lets a terminal-only user pick a preset,
 * type an API key, verify it with one real request, and go straight into a
 * working session — without a Claude.ai account. The original Claude Code
 * login (subscription / Console / Bedrock-Foundry-Vertex) stays available as
 * the last option, and later via /login.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, Text } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { PRODUCT_NAME } from '../constants/product.js'
import { logError } from '../utils/log.js'
import {
  activateSavedProvider,
  ANTHROPIC_OFFICIAL_BASE_URL,
  describeSetupOption,
  listSetupOptions,
  markSuperaiSetupCompleted,
  saveAndActivateNewProvider,
  setupOptionId,
  type SetupOption,
  testProviderConnectivity,
} from '../utils/superaiProviderSetup.js'
import { ConsoleOAuthFlow } from './ConsoleOAuthFlow.js'
import { Select } from './CustomSelect/select.js'
import TextInput from './TextInput.js'

type Stage =
  | { kind: 'loading' }
  | { kind: 'choose' }
  | { kind: 'baseUrl' }
  | { kind: 'apiKey' }
  | { kind: 'model' }
  | { kind: 'testing' }
  | { kind: 'failed'; error: string }
  | { kind: 'saving' }
  | { kind: 'claude-login' }

type Props = {
  onDone(): void
  /**
   * Reports whether a text field is being edited, so a host Dialog can turn
   * its Esc/"n" cancel binding off while the user types (see Dialog.isCancelActive).
   */
  onEditingChange?(editing: boolean): void
}

const SETTINGS_CONTEXT = { context: 'Settings' } as const

/** Draft of the provider being configured. */
type Draft = {
  option: SetupOption | null
  presetId: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  /** True when the model may be left blank (client default). */
  modelOptional: boolean
}

const EMPTY_DRAFT: Draft = {
  option: null,
  presetId: 'custom',
  name: '',
  baseUrl: '',
  apiKey: '',
  model: '',
  modelOptional: false,
}

function draftFor(option: SetupOption): Draft {
  switch (option.kind) {
    case 'preset':
      return {
        option,
        presetId: option.preset.id,
        name: option.preset.name,
        baseUrl: option.preset.baseUrl,
        apiKey: '',
        model: option.preset.defaultModels.main,
        modelOptional: false,
      }
    case 'anthropic-key':
      return {
        option,
        presetId: 'custom',
        name: 'Anthropic',
        baseUrl: ANTHROPIC_OFFICIAL_BASE_URL,
        apiKey: '',
        model: '',
        modelOptional: true,
      }
    case 'custom':
      return { ...EMPTY_DRAFT, option, presetId: 'custom', name: 'Custom' }
    default:
      return { ...EMPTY_DRAFT, option }
  }
}

function optionLabel(option: SetupOption): string {
  switch (option.kind) {
    case 'saved':
      return `${option.provider.name} (saved)`
    case 'preset':
      return option.preset.name
    case 'anthropic-key':
      return 'Anthropic API key'
    case 'custom':
      return 'Custom endpoint'
    case 'claude-login':
      return option.loggedInAs ? `Keep ${option.loggedInAs} account` : 'Claude account login'
  }
}

export function SuperaiProviderSetup({ onDone, onEditingChange }: Props): React.ReactNode {
  const [stage, setStage] = useState<Stage>({ kind: 'loading' })
  const [options, setOptions] = useState<SetupOption[]>([])
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [cursorOffset, setCursorOffset] = useState(0)
  const [hint, setHint] = useState<string | null>(null)
  const { columns } = useTerminalSize()
  const inputColumns = Math.max(20, columns - 4)

  useEffect(() => {
    let cancelled = false
    void listSetupOptions()
      .then(list => {
        if (cancelled) return
        setOptions(list)
        setStage({ kind: 'choose' })
      })
      .catch((err: unknown) => {
        logError(err)
        if (cancelled) return
        setOptions([{ kind: 'custom' }, { kind: 'claude-login', loggedInAs: null }])
        setStage({ kind: 'choose' })
      })
    return () => {
      cancelled = true
    }
  }, [])

  const goToChoose = useCallback(() => {
    setHint(null)
    setDraft(EMPTY_DRAFT)
    setStage({ kind: 'choose' })
  }, [])

  const goBack = useCallback(() => {
    setHint(null)
    switch (stage.kind) {
      case 'baseUrl':
      case 'failed':
        goToChoose()
        break
      case 'apiKey':
        if (draft.option?.kind === 'custom') {
          setCursorOffset(draft.baseUrl.length)
          setStage({ kind: 'baseUrl' })
        } else {
          goToChoose()
        }
        break
      case 'model':
        setCursorOffset(draft.apiKey.length)
        setStage({ kind: 'apiKey' })
        break
      default:
        break
    }
  }, [stage.kind, draft.option, draft.baseUrl.length, draft.apiKey.length, goToChoose])

  const isEditing = stage.kind === 'baseUrl' || stage.kind === 'apiKey' || stage.kind === 'model'
  useKeybinding('confirm:no', goBack, {
    ...SETTINGS_CONTEXT,
    isActive: isEditing,
  })
  useEffect(() => {
    onEditingChange?.(isEditing)
  }, [isEditing, onEditingChange])

  const finish = useCallback(
    async (d: Draft) => {
      setStage({ kind: 'saving' })
      try {
        await saveAndActivateNewProvider({
          presetId: d.presetId,
          name: d.name,
          baseUrl: d.baseUrl,
          apiKey: d.apiKey,
          model: d.model,
        })
        markSuperaiSetupCompleted(`provider:${d.presetId}`)
        onDone()
      } catch (err: unknown) {
        logError(err)
        setStage({
          kind: 'failed',
          error: `Could not save the provider: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    },
    [onDone],
  )

  const runTest = useCallback(
    async (d: Draft) => {
      setStage({ kind: 'testing' })
      try {
        const result = await testProviderConnectivity({
          baseUrl: d.baseUrl,
          apiKey: d.apiKey,
          model: d.model,
        })
        if (result.connectivity.success) {
          await finish(d)
        } else {
          setStage({
            kind: 'failed',
            error: result.connectivity.error ?? 'The endpoint did not answer a test request.',
          })
        }
      } catch (err: unknown) {
        logError(err)
        setStage({
          kind: 'failed',
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [finish],
  )

  const handleChoose = useCallback(
    (id: string) => {
      const option = options.find(o => setupOptionId(o) === id)
      if (!option) return
      setHint(null)
      switch (option.kind) {
        case 'claude-login':
          if (option.loggedInAs) {
            // Already signed in on this machine: keeping that account needs no
            // login flow. Remember the choice so the setup is not offered again.
            markSuperaiSetupCompleted('claude-account')
            onDone()
            return
          }
          setStage({ kind: 'claude-login' })
          return
        case 'saved': {
          setStage({ kind: 'saving' })
          void activateSavedProvider(option.provider.id)
            .then(() => {
              markSuperaiSetupCompleted(`saved:${option.provider.id}`)
              onDone()
            })
            .catch((err: unknown) => {
              logError(err)
              setStage({
                kind: 'failed',
                error: `Could not activate ${option.provider.name}: ${err instanceof Error ? err.message : String(err)}`,
              })
            })
          return
        }
        case 'custom': {
          const d = draftFor(option)
          setDraft(d)
          setCursorOffset(0)
          setStage({ kind: 'baseUrl' })
          return
        }
        default: {
          const d = draftFor(option)
          setDraft(d)
          setCursorOffset(0)
          setStage({ kind: 'apiKey' })
        }
      }
    },
    [options, onDone],
  )

  const submitBaseUrl = useCallback(
    (value: string) => {
      const trimmed = value.trim()
      if (!trimmed) {
        goToChoose()
        return
      }
      try {
        const u = new URL(trimmed)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme')
      } catch {
        setHint('Enter a full URL, e.g. https://api.example.com/anthropic')
        return
      }
      setHint(null)
      setDraft(d => ({ ...d, baseUrl: trimmed }))
      setCursorOffset(0)
      setStage({ kind: 'apiKey' })
    },
    [goToChoose],
  )

  const submitApiKey = useCallback(
    (value: string) => {
      const trimmed = value.trim()
      if (!trimmed) {
        goBack()
        return
      }
      setHint(null)
      const next = { ...draft, apiKey: trimmed }
      setDraft(next)
      setCursorOffset(next.model.length)
      setStage({ kind: 'model' })
    },
    [draft, goBack],
  )

  const submitModel = useCallback(
    (value: string) => {
      const trimmed = value.trim()
      if (!trimmed && !draft.modelOptional) {
        setHint('A model id is required for this endpoint (e.g. claude-sonnet-4-6)')
        return
      }
      setHint(null)
      const next = { ...draft, model: trimmed }
      setDraft(next)
      void runTest(next)
    },
    [draft, runTest],
  )

  const chooseOptions = useMemo(
    () =>
      options.map(o => ({
        label: optionLabel(o),
        value: setupOptionId(o),
        description: describeSetupOption(o),
        disabled: o.kind === 'saved' && o.needsDesktopProxy,
      })),
    [options],
  )

  const existingLogin = useMemo(() => {
    const claude = options.find(o => o.kind === 'claude-login')
    return claude?.kind === 'claude-login' ? claude.loggedInAs : null
  }, [options])

  const failedOptions = useMemo(
    () => [
      { label: 'Try again', value: 'retry' },
      { label: 'Save anyway', value: 'save', description: 'keep this configuration without a successful test' },
      { label: 'Start over', value: 'restart' },
    ],
    [],
  )

  const handleFailedChoice = useCallback(
    (value: string) => {
      switch (value) {
        case 'retry':
          if (draft.option) {
            setCursorOffset(draft.apiKey.length)
            setStage({ kind: 'apiKey' })
          } else {
            goToChoose()
          }
          break
        case 'save':
          if (draft.option) void finish(draft)
          else goToChoose()
          break
        default:
          goToChoose()
      }
    },
    [draft, finish, goToChoose],
  )

  if (stage.kind === 'claude-login') {
    return (
      <ConsoleOAuthFlow
        onDone={() => {
          markSuperaiSetupCompleted('claude-login')
          onDone()
        }}
      />
    )
  }

  const target = draft.name || 'the endpoint'

  return (
    <Box flexDirection="column" gap={1} marginTop={1}>
      <Text bold>
        {PRODUCT_NAME} works with any Anthropic-compatible API. Configure a model provider to get
        started:
      </Text>
      {existingLogin && stage.kind === 'choose' && (
        <Text dimColor>
          This machine is signed in to a {existingLogin} account, which the terminal would otherwise
          use. Pick a provider below to use SuperAI's own API-key configuration instead, or keep the
          account.
        </Text>
      )}

      {stage.kind === 'loading' && <Text dimColor>Loading providers...</Text>}

      {stage.kind === 'choose' && (
        <Box flexDirection="column">
          <Text>Select a provider:</Text>
          <Box marginTop={1}>
            <Select options={chooseOptions} onChange={handleChoose} visibleOptionCount={12} />
          </Box>
          <Text dimColor>The choice is saved to ~/.claude/superai and shared with the desktop app.</Text>
        </Box>
      )}

      {stage.kind === 'baseUrl' && (
        <Box flexDirection="column">
          <Text>Base URL of the Anthropic-compatible endpoint:</Text>
          <Box marginTop={1}>
            <Text>{'> '}</Text>
            <TextInput
              value={draft.baseUrl}
              onChange={v => setDraft(d => ({ ...d, baseUrl: v }))}
              onSubmit={submitBaseUrl}
              placeholder="https://api.example.com/anthropic"
              columns={inputColumns}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
              focus
              showCursor
            />
          </Box>
          {hint && <Text color="error">{hint}</Text>}
          <Text dimColor>Enter to continue - Esc or empty to go back</Text>
        </Box>
      )}

      {stage.kind === 'apiKey' && (
        <Box flexDirection="column">
          <Text>
            API key for <Text bold>{target}</Text>
            {draft.baseUrl ? <Text dimColor> ({draft.baseUrl})</Text> : null}:
          </Text>
          <Box marginTop={1}>
            <Text>{'> '}</Text>
            <TextInput
              value={draft.apiKey}
              onChange={v => setDraft(d => ({ ...d, apiKey: v }))}
              onSubmit={submitApiKey}
              placeholder="paste your API key"
              columns={inputColumns}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
              mask="*"
              focus
              showCursor
            />
          </Box>
          {hint && <Text color="error">{hint}</Text>}
          <Text dimColor>Enter to continue - Esc or empty to go back</Text>
        </Box>
      )}

      {stage.kind === 'model' && (
        <Box flexDirection="column">
          <Text>
            Model id{draft.modelOptional ? ' (optional - leave blank for the default)' : ''}:
          </Text>
          <Box marginTop={1}>
            <Text>{'> '}</Text>
            <TextInput
              value={draft.model}
              onChange={v => setDraft(d => ({ ...d, model: v }))}
              onSubmit={submitModel}
              placeholder={draft.modelOptional ? 'default' : 'e.g. claude-sonnet-4-6'}
              columns={inputColumns}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
              focus
              showCursor
            />
          </Box>
          {hint && <Text color="error">{hint}</Text>}
          <Text dimColor>Enter to test the connection - Esc to go back</Text>
        </Box>
      )}

      {stage.kind === 'testing' && (
        <Text>
          Testing {target}
          {draft.model ? ` with ${draft.model}` : ''}... <Text dimColor>(up to 30s)</Text>
        </Text>
      )}

      {stage.kind === 'saving' && <Text>Saving provider...</Text>}

      {stage.kind === 'failed' && (
        <Box flexDirection="column">
          <Text color="error">Connection test failed: {stage.error}</Text>
          <Box marginTop={1}>
            <Select options={failedOptions} onChange={handleFailedChoice} onCancel={goToChoose} />
          </Box>
        </Box>
      )}
    </Box>
  )
}
