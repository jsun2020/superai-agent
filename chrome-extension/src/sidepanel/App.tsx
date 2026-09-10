import { useCallback, useEffect, useRef, useState } from 'react'
import { AgentClient, type ConnectionState } from './agentClient'
import { bg, DEFAULT_SETTINGS, loadSessionId, loadSettings, saveSessionId, saveSettings, type Settings } from './bridge'
import { composeMessage, formatPageContext, summarizeSnapshot, type ElementCapture } from '../lib/pageContext'
import {
  addUserMessage,
  decidePermission,
  emptyTranscript,
  pendingPermissions,
  reduceServerMessage,
  type ToolItem,
  type Transcript,
} from '../lib/transcript'

type Health = 'checking' | 'online' | 'offline'

/** Minimal text rendering: fenced code blocks become <pre>, the rest keeps its line breaks. */
function RenderText({ text }: { text: string }) {
  const parts = text.split(/```[a-zA-Z0-9_-]*\n?/)
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <pre key={i} className="code">{p.replace(/\n$/, '')}</pre>
        ) : (
          <span key={i} className="prose">{p}</span>
        ),
      )}
    </>
  )
}

function ToolCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false)
  const status = !item.done ? '…' : item.isError ? '✗' : '✓'
  const inputPreview = item.input ? JSON.stringify(item.input) : item.inputText
  return (
    <div className={`tool ${item.isError ? 'tool-error' : ''}`}>
      <button className="tool-head" onClick={() => setOpen(!open)} type="button">
        <span className="tool-status">{status}</span>
        <span className="tool-name">{item.toolName}</span>
        <span className="tool-preview">{inputPreview.slice(0, 80)}</span>
      </button>
      {open && (
        <div className="tool-body">
          <pre className="code">{inputPreview}</pre>
          {item.done && <pre className="code">{typeof item.result === 'string' ? item.result.slice(0, 4000) : JSON.stringify(item.result, null, 1)?.slice(0, 4000)}</pre>}
        </div>
      )}
    </div>
  )
}

export function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [showSettings, setShowSettings] = useState(false)
  const [health, setHealth] = useState<Health>('checking')
  const [conn, setConn] = useState<ConnectionState>('closed')
  const [transcript, setTranscript] = useState<Transcript>(emptyTranscript())
  const [input, setInput] = useState('')
  const [screenshot, setScreenshot] = useState<string | null>(null)
  const [element, setElement] = useState<ElementCapture | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const clientRef = useRef<AgentClient | null>(null)
  const sessionRef = useRef<string | null>(null)
  const windowIdRef = useRef<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Settings + window identity.
  useEffect(() => {
    void (async () => {
      const s = await loadSettings()
      setSettings(s)
      const win = await chrome.windows.getCurrent()
      windowIdRef.current = win.id ?? null
      if (win.id !== undefined) sessionRef.current = await loadSessionId(win.id)
    })()
  }, [])

  // Reachability, re-checked while offline so the indicator recovers on its own.
  useEffect(() => {
    let cancelled = false
    const check = async () => {
      const ok = await AgentClient.health(settings.serverUrl)
      if (!cancelled) setHealth(ok ? 'online' : 'offline')
    }
    void check()
    const t = setInterval(check, 10_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [settings.serverUrl])

  // The context menu tells us when an element was captured.
  useEffect(() => {
    const onMsg = (msg: { type?: string; element?: ElementCapture | null }) => {
      if (msg?.type === 'elementCaptured') setElement(msg.element ?? null)
    }
    chrome.runtime.onMessage.addListener(onMsg)
    return () => chrome.runtime.onMessage.removeListener(onMsg)
  }, [])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [transcript.items.length, transcript.state])

  const ensureClient = useCallback(async (): Promise<AgentClient> => {
    if (clientRef.current && clientRef.current.baseUrl === settings.serverUrl) return clientRef.current
    clientRef.current?.close()
    const client = new AgentClient(
      settings.serverUrl,
      (m) => setTranscript((t) => reduceServerMessage(t, m)),
      setConn,
    )
    clientRef.current = client
    return client
  }, [settings.serverUrl])

  const ensureSession = useCallback(async (): Promise<{ client: AgentClient; sessionId: string }> => {
    const client = await ensureClient()
    let sessionId = sessionRef.current
    if (!sessionId) {
      sessionId = await client.createSession(settings.workDir.trim() || undefined)
      sessionRef.current = sessionId
      if (windowIdRef.current !== null) await saveSessionId(windowIdRef.current, sessionId)
    }
    if (conn !== 'open') {
      client.connect(sessionId)
      await new Promise<void>((resolve, reject) => {
        const started = Date.now()
        const tick = () => {
          if (client.send({ type: 'ping' })) return resolve()
          if (Date.now() - started > 8000) return reject(new Error('WebSocket did not open'))
          setTimeout(tick, 100)
        }
        tick()
      })
    }
    return { client, sessionId }
  }, [conn, ensureClient, settings.workDir])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || transcript.state === 'streaming' || transcript.state === 'thinking' || transcript.state === 'tool_executing') return
    setNotice(null)
    const tab = await bg.getActiveTab()
    let block = ''
    let summary = ''
    if (settings.attachContext && tab?.id !== undefined) {
      const snap = await bg.getSnapshot(tab.id)
      if (snap) {
        block = formatPageContext(snap)
        summary = summarizeSnapshot(snap)
      }
    }
    const attachments = screenshot
      ? [{ type: 'image' as const, name: 'screenshot.jpg', mimeType: 'image/jpeg', data: screenshot.replace(/^data:[^,]+,/, '') }]
      : []
    try {
      const { client } = await ensureSession()
      setTranscript((t) => addUserMessage(t, text, summary || undefined, attachments.length || undefined))
      client.send({ type: 'user_message', content: composeMessage(text, block), attachments: attachments.length ? attachments : undefined })
      setInput('')
      setScreenshot(null)
      if (element && tab?.id !== undefined) {
        // The element travelled with this message; do not re-send it next time.
        await bg.clearElement(tab.id)
        setElement(null)
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    }
  }, [element, ensureSession, input, screenshot, settings.attachContext, transcript.state])

  const stop = () => clientRef.current?.send({ type: 'stop_generation' })

  const newChat = async () => {
    clientRef.current?.close()
    clientRef.current = null
    sessionRef.current = null
    if (windowIdRef.current !== null) await saveSessionId(windowIdRef.current, null)
    setTranscript(emptyTranscript())
    setConn('closed')
  }

  const takeScreenshot = async () => {
    const tab = await bg.getActiveTab()
    if (!tab) return
    const res = await bg.captureScreenshot(tab.windowId)
    if (res?.dataUrl) setScreenshot(res.dataUrl)
    else setNotice(`Screenshot failed: ${res?.error ?? 'unknown'}`)
  }

  const clearCaptured = async () => {
    const tab = await bg.getActiveTab()
    if (tab?.id !== undefined) await bg.clearSnapshot(tab.id)
    setElement(null)
    setNotice('Captured console and network entries cleared for this tab.')
  }

  const answerPermission = (requestId: string, allowed: boolean) => {
    clientRef.current?.send({ type: 'permission_response', requestId, allowed })
    setTranscript((t) => decidePermission(t, requestId, allowed))
  }

  const busy = transcript.state !== 'idle' && transcript.state !== 'permission_pending'
  const pending = pendingPermissions(transcript)

  return (
    <div className="app">
      <header className="top">
        <span className="brand">SuperAI Agent</span>
        <span className={`dot ${health}`} title={`${settings.serverUrl} — ${health}`} />
        <span className="muted small">{health === 'online' ? (conn === 'open' ? 'session' : 'ready') : health === 'offline' ? 'desktop app not running' : '…'}</span>
        <span className="spacer" />
        <button type="button" className="icon" title="New chat" onClick={newChat}>＋</button>
        <button type="button" className="icon" title="Settings" onClick={() => setShowSettings(!showSettings)}>⚙</button>
      </header>

      {showSettings && (
        <section className="settings">
          <label>
            Server
            <input value={settings.serverUrl} onChange={(e) => setSettings({ ...settings, serverUrl: e.target.value })} onBlur={() => void saveSettings({ ...settings, serverUrl: AgentClient.normalizeBaseUrl(settings.serverUrl) })} placeholder="http://127.0.0.1:3456" />
          </label>
          <label>
            Project folder (lets the agent read and edit the site's code)
            <input value={settings.workDir} onChange={(e) => setSettings({ ...settings, workDir: e.target.value })} onBlur={() => void saveSettings(settings)} placeholder="C:\src\my-web-app" />
          </label>
          <p className="muted small">A new chat is needed after changing the folder. Nothing leaves this browser except the message you send to the local server.</p>
        </section>
      )}

      <div className="toolbar">
        <label className="check">
          <input type="checkbox" checked={settings.attachContext} onChange={(e) => { const s = { ...settings, attachContext: e.target.checked }; setSettings(s); void saveSettings(s) }} />
          Attach page context
        </label>
        <button type="button" onClick={takeScreenshot} title="Attach a screenshot of the visible tab">📷</button>
        <button type="button" onClick={clearCaptured} title="Clear captured console and network entries">🧹</button>
        {screenshot && <span className="chip" onClick={() => setScreenshot(null)} title="Remove">screenshot ×</span>}
        {element && <span className="chip" onClick={() => setElement(null)} title="Attached from the context menu">element ×</span>}
      </div>

      {notice && <div className="notice">{notice}</div>}

      <div className="list" ref={listRef}>
        {transcript.items.length === 0 && (
          <div className="empty muted">
            Ask about the page you are on. With <b>Attach page context</b> on, recent console errors, failed requests and the element you right-clicked ("Ask SuperAI Agent about this element") go with your message.
          </div>
        )}
        {transcript.items.map((item, i) => {
          switch (item.kind) {
            case 'text':
              return (
                <div key={i} className={`msg ${item.role}`}>
                  <RenderText text={item.text} />
                  {(item.contextSummary || item.attachments) && (
                    <div className="meta muted small">
                      {item.contextSummary ? `page context: ${item.contextSummary}` : ''}
                      {item.attachments ? `${item.contextSummary ? ' · ' : ''}${item.attachments} image` : ''}
                    </div>
                  )}
                </div>
              )
            case 'tool':
              return <ToolCard key={i} item={item} />
            case 'permission':
              return (
                <div key={i} className="perm">
                  <div><b>{item.toolName}</b> {item.description ?? ''}</div>
                  <pre className="code">{JSON.stringify(item.input, null, 1)?.slice(0, 1500)}</pre>
                  {item.decided ? (
                    <div className="muted small">{item.decided}</div>
                  ) : (
                    <div className="row">
                      <button type="button" onClick={() => answerPermission(item.requestId, true)}>Allow</button>
                      <button type="button" onClick={() => answerPermission(item.requestId, false)}>Deny</button>
                    </div>
                  )}
                </div>
              )
            case 'error':
              return <div key={i} className="err">{item.message}</div>
          }
        })}
        {busy && <div className="muted small status">{transcript.state}…</div>}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder={health === 'online' ? 'Ask about this page…' : 'Start the SuperAI Agent desktop app first'}
          rows={3}
          disabled={health !== 'online'}
        />
        <div className="row">
          {busy ? (
            <button type="button" onClick={stop}>Stop</button>
          ) : (
            <button type="submit" disabled={!input.trim() || health !== 'online' || pending.length > 0}>Send</button>
          )}
        </div>
      </form>
    </div>
  )
}
