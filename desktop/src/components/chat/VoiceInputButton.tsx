import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useTranslation } from '../../i18n'
import {
  createVoiceInput,
  type VoiceInput,
  type VoiceState,
} from '../../lib/voiceInput'

type BridgeInfo = { port: number; token: string }

type Props = {
  /** Called once per utterance with the finished transcript. */
  onFinal: (text: string) => void
  /** Live interim text, so the composer can show words as they are said. */
  onPartial?: (text: string) => void
  disabled?: boolean
}

/**
 * Mic control for the composer, driving TypeFree over its loopback bridge.
 *
 * Absence is the normal case: most users do not run TypeFree, so when the
 * bridge cannot be found this renders NOTHING rather than a dead button. A
 * control that is always visible but usually broken is worse than no control -
 * and this composer already carries enough that only works sometimes.
 */
export function VoiceInputButton({ onFinal, onPartial, disabled }: Props) {
  const t = useTranslation()
  const [bridge, setBridge] = useState<BridgeInfo | null>(null)
  const [state, setState] = useState<VoiceState>('idle')
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const viRef = useRef<VoiceInput | null>(null)

  // Only our own process can read TypeFree's token file, so discovery goes
  // through Rust. A missing file simply means TypeFree is not running.
  useEffect(() => {
    let cancelled = false
    const probe = async () => {
      try {
        const info = await invoke<BridgeInfo | null>('typefree_bridge_info')
        if (!cancelled) setBridge(info ?? null)
      } catch {
        if (!cancelled) setBridge(null)
      }
    }
    void probe()
    // TypeFree may be started after the app; re-check occasionally so the
    // button appears without needing a restart. 15s is slow enough to be free
    // and fast enough not to feel broken.
    const timer = setInterval(probe, 15_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (!bridge) return
    const vi = createVoiceInput({
      port: bridge.port,
      token: bridge.token,
      // The composer inserts the text itself; without this TypeFree would ALSO
      // paste it into the focused window and every utterance would appear twice.
      output: 'callback',
      mode: 'ptt',
    })
    viRef.current = vi
    const offs = [
      vi.on('state', setState),
      vi.on('level', setLevel),
      vi.on('partial', (text) => onPartial?.(text)),
      vi.on('final', (r) => {
        if (r.text.trim()) onFinal(r.text)
        setLevel(0)
      }),
      vi.on('error', (e) => {
        setError(e.message)
        setState('idle')
        // A stale discovery file points at a TypeFree that has gone away.
        // Dropping it hides the button until the next probe finds a live one.
        if (e.kind === 'network' || e.kind === 'auth') setBridge(null)
      }),
    ]
    void vi.connect().catch(() => {
      // Reported through the error event above.
    })
    return () => {
      offs.forEach((off) => off())
      vi.close()
      viRef.current = null
    }
  }, [bridge, onFinal, onPartial])

  const toggle = useCallback(() => {
    const vi = viRef.current
    if (!vi) return
    setError(null)
    if (state === 'listening') void vi.stop()
    else void vi.start()
  }, [state])

  if (!bridge) return null

  const listening = state === 'listening'
  const busy = state === 'thinking' || state === 'finalizing' || state === 'encoding'
  const label = listening ? t('chat.voiceStop') : t('chat.voiceStart')

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled || busy}
      aria-label={label}
      aria-pressed={listening}
      title={error ?? label}
      className={`relative rounded-[var(--radius-md)] p-1.5 transition-colors disabled:opacity-40 ${
        listening
          ? 'bg-[var(--color-error-container)] text-[var(--color-on-error-container)]'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
      }`}
    >
      <span className="material-symbols-outlined text-[18px]">
        {busy ? 'hourglass_top' : listening ? 'stop_circle' : 'mic'}
      </span>
      {listening && (
        // Mic level, so a silent mic is visibly distinguishable from a working
        // one - the difference between "it is not listening" and "it heard
        // nothing", which users otherwise cannot tell apart.
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-1 bottom-0.5 h-0.5 origin-left rounded bg-current transition-transform duration-100"
          style={{ transform: `scaleX(${Math.max(0.05, Math.min(1, level))})` }}
        />
      )}
    </button>
  )
}
