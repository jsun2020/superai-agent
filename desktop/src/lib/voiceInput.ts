/**
 * Client for TypeFree's loopback voice-input bridge.
 *
 * VENDORED from the typefree repo (`sdk/index.js`, protocol 1) rather than
 * imported. superai-agent's release builds run on five platforms in GitHub
 * Actions where the typefree checkout does not exist, so a `file:../typefree`
 * dependency or a relative import would break every CI build. The SDK is one
 * dependency-free file over a versioned wire protocol, which makes copying it
 * the cheaper trade. Keep `PROTOCOL` in step with the bridge's `hello`.
 *
 * TypeFree owns microphone capture and speech recognition; this is only control
 * and events. That is not a simplification - its engine needs Node native
 * modules (sherpa-onnx-node, koffi) that a Tauri webview cannot load.
 */

export const PROTOCOL = 1

/** Error kinds a caller can act on differently. */
export type VoiceErrorKind =
  | 'mic-permission'
  | 'network'
  | 'auth'
  | 'encode'
  | 'provider'

export type VoiceState =
  | 'idle'
  | 'listening'
  | 'encoding'
  | 'thinking'
  | 'finalizing'
  | 'error'

export type VoiceFinal = {
  text: string
  lang: string
  /**
   * Measured here, from start() to the final result. The engine reports its own
   * `ms`, but that is stop->ready latency rather than utterance length, so it is
   * kept separately under `engine` instead of being passed off as duration.
   */
  durationMs: number | null
  engine: { via?: string; ms?: number; thinkingMs?: number }
}

type Events = {
  state: VoiceState
  level: number
  partial: string
  final: VoiceFinal
  error: { kind: VoiceErrorKind; message: string }
}

const ERROR_KINDS: ReadonlySet<string> = new Set([
  'mic-permission',
  'network',
  'auth',
  'encode',
  'provider',
])

const RECONNECT_BASE_MS = 250
const RECONNECT_MAX_MS = 5000

export type VoiceInputOptions = {
  port: number
  token: string
  host?: string
  /** 'callback' stops TypeFree pasting into the focused window - see below. */
  output?: 'callback' | 'inject'
  mode?: 'ptt' | 'toggle' | 'auto-vad'
  lang?: string
  autoReconnect?: boolean
}

export function createVoiceInput(options: VoiceInputOptions) {
  const {
    port,
    token,
    host = '127.0.0.1',
    // The host app inserts the transcript itself. Leaving injection on would
    // ALSO paste it into the focused window, so every utterance would land in
    // the composer twice.
    output = 'callback',
    mode = 'ptt',
    lang = 'auto',
    autoReconnect = true,
  } = options

  if (!port) throw new Error('createVoiceInput requires the bridge port')
  if (!token) throw new Error('createVoiceInput requires the bridge token')

  const listeners = new Map<string, Set<(payload: never) => void>>()
  let socket: WebSocket | null = null
  let closed = false
  let state: VoiceState = 'idle'
  let startedAt: number | null = null
  let reconnectAttempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let nextId = 1

  function on<K extends keyof Events>(
    event: K,
    fn: (payload: Events[K]) => void,
  ): () => void {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event)!.add(fn as (payload: never) => void)
    return () => {
      listeners.get(event)?.delete(fn as (payload: never) => void)
    }
  }

  function emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = listeners.get(event)
    if (!set) return
    for (const fn of set) {
      try {
        ;(fn as (p: Events[K]) => void)(payload)
      } catch (e) {
        // One bad listener must not kill the session or starve the others.
        console.error('[voice] listener threw:', e)
      }
    }
  }

  function setState(next: VoiceState) {
    if (state === next) return
    state = next
    emit('state', next)
  }

  function emitError(kind: string, message: string) {
    emit('error', {
      kind: (ERROR_KINDS.has(kind) ? kind : 'provider') as VoiceErrorKind,
      message,
    })
  }

  function handleMessage(raw: string) {
    let msg: { type?: string; payload?: unknown; kind?: string; message?: string }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    switch (msg.type) {
      case 'state':
        setState(msg.payload as VoiceState)
        return
      case 'level':
        emit('level', Number(msg.payload) || 0)
        return
      case 'partial':
        emit('partial', ((msg.payload as { text?: string })?.text ?? '') as string)
        return
      case 'final': {
        const p = (msg.payload ?? {}) as Record<string, unknown>
        emit('final', {
          text: (p.text as string) ?? '',
          lang: (p.lang as string) ?? lang,
          durationMs: startedAt == null ? null : Date.now() - startedAt,
          engine: {
            via: p.via as string | undefined,
            ms: p.ms as number | undefined,
            thinkingMs: p.thinkingMs as number | undefined,
          },
        })
        startedAt = null
        return
      }
      case 'error':
        emitError(msg.kind ?? 'provider', msg.message ?? '')
        return
      default:
        return
    }
  }

  function scheduleReconnect() {
    if (!autoReconnect || closed) return
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** reconnectAttempt,
    )
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connect().catch(() => {
        // Already reported through the error event.
      })
    }, delay)
  }

  function connect(): Promise<void> {
    if (closed) return Promise.reject(new Error('voice input is closed'))
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false
      // A browser WebSocket fires 'error' with NO 'close' when the connection
      // is refused, unlike Node's `ws` which fires both. Reporting only from
      // 'close' would leave an unreachable TypeFree completely silent here -
      // this is a webview. Whichever arrives first reports; the flag prevents
      // a duplicate.
      let reported = false
      let ws: WebSocket
      try {
        ws = new WebSocket(
          `ws://${host}:${port}/?token=${encodeURIComponent(token)}`,
        )
      } catch (e) {
        emitError('network', String(e))
        scheduleReconnect()
        reject(e as Error)
        return
      }
      socket = ws

      ws.addEventListener('open', () => {
        reconnectAttempt = 0
        settled = true
        resolve()
      })
      ws.addEventListener('message', (ev) => handleMessage(String(ev.data)))
      ws.addEventListener('close', (ev) => {
        socket = null
        // The bridge refuses a bad token with 1008. Retrying cannot fix a wrong
        // credential, so report it as auth and stop rather than spin.
        if (ev.code === 1008) {
          emitError('auth', 'TypeFree rejected this connection')
          if (!settled) reject(new Error('unauthorized'))
          return
        }
        if (!settled && !reported) {
          reported = true
          emitError('network', 'could not reach TypeFree')
          reject(new Error('connect failed'))
        }
        scheduleReconnect()
      })
      ws.addEventListener('error', () => {
        if (settled || reported) return
        reported = true
        socket = null
        emitError('network', 'could not reach TypeFree')
        reject(new Error('connect failed'))
        scheduleReconnect()
      })
    })
  }

  function sendCommand(type: string, extra?: Record<string, unknown>) {
    if (!socket || socket.readyState !== 1) {
      emitError('network', 'not connected to TypeFree')
      return
    }
    socket.send(JSON.stringify({ type, id: nextId++, ...(extra ?? {}) }))
  }

  async function start() {
    await connect()
    // A repeated click or hotkey must not open a second session.
    if (state === 'listening') return
    startedAt = Date.now()
    sendCommand('start', { output, mode, lang })
  }

  async function stop() {
    if (!socket || socket.readyState !== 1) return
    sendCommand('stop')
  }

  function close() {
    closed = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (socket) {
      try {
        socket.close()
      } catch {
        // Already gone.
      }
      socket = null
    }
    listeners.clear()
  }

  return {
    on,
    start,
    stop,
    close,
    connect,
    get state() {
      return state
    },
    get connected() {
      return !!socket && socket.readyState === 1
    },
  }
}

export type VoiceInput = ReturnType<typeof createVoiceInput>
