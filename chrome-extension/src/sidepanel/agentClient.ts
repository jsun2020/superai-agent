/**
 * Thin client of the local SuperAI Agent server: session creation over REST,
 * chat over the /ws/:sessionId WebSocket. No protocol logic here beyond
 * framing - see lib/transcript.ts for how events become the transcript.
 */

import type { ClientMessage, ServerMessage } from '../lib/protocol'

export type ConnectionState = 'connecting' | 'open' | 'closed'

export class AgentClient {
  private ws: WebSocket | null = null
  private intentionalClose = false
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0

  constructor(
    public readonly baseUrl: string,
    private readonly onMessage: (m: ServerMessage) => void,
    private readonly onState: (s: ConnectionState) => void,
  ) {}

  static normalizeBaseUrl(input: string): string {
    const s = input.trim().replace(/\/+$/, '')
    if (!s) return 'http://127.0.0.1:3456'
    return /^https?:\/\//.test(s) ? s : `http://${s}`
  }

  static async health(baseUrl: string, timeoutMs = 2500): Promise<boolean> {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) })
      return res.ok
    } catch {
      return false
    }
  }

  async createSession(workDir?: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(workDir ? { workDir } : {}),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Could not create a session (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`)
    }
    const body = (await res.json()) as { sessionId?: string }
    if (!body.sessionId) throw new Error('Server returned no session id')
    return body.sessionId
  }

  connect(sessionId: string): void {
    this.close()
    this.intentionalClose = false
    this.onState('connecting')
    const ws = new WebSocket(`${this.baseUrl.replace(/^http/, 'ws')}/ws/${sessionId}`)
    this.ws = ws
    ws.onopen = () => {
      this.attempt = 0
      this.onState('open')
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), 30_000)
    }
    ws.onmessage = (ev) => {
      try {
        this.onMessage(JSON.parse(String(ev.data)) as ServerMessage)
      } catch {
        // malformed frame
      }
    }
    ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = null
      this.onState('closed')
      if (!this.intentionalClose && this.ws === ws) {
        const delay = Math.min(5000, 300 * 2 ** this.attempt++)
        this.reconnectTimer = setTimeout(() => this.connect(sessionId), delay)
      }
    }
  }

  send(msg: ClientMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
      return true
    }
    return false
  }

  close(): void {
    this.intentionalClose = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
    const ws = this.ws
    this.ws = null
    try {
      ws?.close()
    } catch {
      // already gone
    }
  }
}
