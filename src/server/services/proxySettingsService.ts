/**
 * Proxy Settings Service
 *
 * Stores HTTP/HTTPS proxy config inside ~/.claude/superai/settings.json
 * under the `env` key, so the existing managedEnv flow auto-loads it
 * into process.env on sidecar boot, and undici picks it up via
 * proxy.ts:configureGlobalAgents().
 *
 * The UI presents host/port/account/password as four fields; the
 * service composes the URL `http://user:pass@host:port` (Basic auth)
 * and writes both HTTPS_PROXY and HTTP_PROXY to the same value.
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import * as net from 'node:net'
import { ApiError } from '../middleware/errorHandler.js'

export type ProxyConfig = {
  enabled: boolean
  host: string
  port: number | null
  username: string
  password: string
}

export type ProxyTestResult = {
  ok: boolean
  status?: number
  latencyMs?: number
  error?: string
  /** Authentication schemes the proxy demanded if it returned 407. */
  authChallenges?: string[]
  /** Hint string the UI can render when a known limitation is detected. */
  hint?: 'ntlm-not-supported' | 'negotiate-not-supported' | 'auth-required'
}

const EMPTY_CONFIG: ProxyConfig = {
  enabled: false,
  host: '',
  port: null,
  username: '',
  password: '',
}

export class ProxySettingsService {
  private getConfigDir(): string {
    return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  }

  private getSettingsPath(): string {
    return path.join(this.getConfigDir(), 'superai', 'settings.json')
  }

  // ─── persistence ─────────────────────────────────────────────────────────

  private async readSettings(): Promise<Record<string, unknown>> {
    try {
      const raw = await fs.readFile(this.getSettingsPath(), 'utf-8')
      return JSON.parse(raw) as Record<string, unknown>
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw ApiError.internal(`Failed to read settings.json: ${err}`)
    }
  }

  private async writeSettings(data: Record<string, unknown>): Promise<void> {
    const filePath = this.getSettingsPath()
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const tmp = `${filePath}.tmp.${Date.now()}`
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8')
      await fs.rename(tmp, filePath)
    } catch (err) {
      await fs.unlink(tmp).catch(() => {})
      throw ApiError.internal(`Failed to write settings.json: ${err}`)
    }
  }

  // ─── URL composition / parsing ───────────────────────────────────────────

  /** Build `http://[user[:pass]@]host:port` from form fields. */
  private buildProxyUrl(cfg: ProxyConfig): string {
    const host = cfg.host.trim()
    if (!host) return ''
    const port = cfg.port ?? 0
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      throw ApiError.badRequest('Proxy port must be 1-65535')
    }
    const auth =
      cfg.username.trim().length > 0
        ? `${encodeURIComponent(cfg.username)}:${encodeURIComponent(cfg.password)}@`
        : ''
    return `http://${auth}${host}:${port}`
  }

  /** Parse a stored proxy URL back into form fields (best-effort). */
  private parseProxyUrl(url: string): ProxyConfig {
    if (!url) return { ...EMPTY_CONFIG }
    try {
      const u = new URL(url)
      return {
        enabled: true,
        host: u.hostname,
        port: u.port ? Number(u.port) : null,
        username: decodeURIComponent(u.username || ''),
        password: decodeURIComponent(u.password || ''),
      }
    } catch {
      return { ...EMPTY_CONFIG }
    }
  }

  // ─── public API ──────────────────────────────────────────────────────────

  async getConfig(): Promise<ProxyConfig> {
    const settings = await this.readSettings()
    const env = (settings.env ?? {}) as Record<string, unknown>
    const url = typeof env.HTTPS_PROXY === 'string' ? env.HTTPS_PROXY : ''
    return this.parseProxyUrl(url)
  }

  async setConfig(input: ProxyConfig): Promise<void> {
    const settings = await this.readSettings()
    const env = ((settings.env ?? {}) as Record<string, unknown>) || {}

    if (!input.enabled || !input.host.trim()) {
      delete env.HTTPS_PROXY
      delete env.HTTP_PROXY
      // Don't strip NO_PROXY — user may have set it independently.
    } else {
      const url = this.buildProxyUrl(input)
      env.HTTPS_PROXY = url
      env.HTTP_PROXY = url
      // Always include loopback in NO_PROXY when a proxy is enabled.
      // The desktop chat path spawns a CLI subprocess that connects back
      // to the local server's WebSocket at ws://127.0.0.1:<port>. Without
      // this, the WebSocket transport routes that loopback connection
      // through the corporate proxy, the proxy refuses CONNECT to a
      // private IP, and the chat hangs at "Cogitating..." forever.
      env.NO_PROXY = mergeNoProxy(env.NO_PROXY)
    }

    settings.env = env
    await this.writeSettings(settings)

    // Apply to current process so the sidecar's own outgoing calls
    // (e.g. provider connectivity tests via fetch()) start using the new
    // proxy without an app restart. Bun's native fetch reads HTTPS_PROXY
    // from process.env on each call — that mutation is what does the
    // actual work here. configureGlobalAgents() updates axios's proxy
    // agent for the few code paths still using axios; undici's
    // setGlobalDispatcher is a no-op in Bun but doesn't hurt.
    //
    // Spawned CLI subprocesses still need a session restart because
    // they inherited env at spawn time.
    if (env.HTTPS_PROXY) {
      process.env.HTTPS_PROXY = String(env.HTTPS_PROXY)
      process.env.HTTP_PROXY = String(env.HTTP_PROXY ?? env.HTTPS_PROXY)
      if (env.NO_PROXY) process.env.NO_PROXY = String(env.NO_PROXY)
    } else {
      delete process.env.HTTPS_PROXY
      delete process.env.HTTP_PROXY
      delete process.env.https_proxy
      delete process.env.http_proxy
    }

    try {
      const proxyMod = await import('../../utils/proxy.js')
      proxyMod.clearProxyCache()
      proxyMod.configureGlobalAgents()
    } catch {
      // proxy.ts always exists; if dynamic import fails, fall back to
      // requiring an app restart. Don't fail the save.
    }
  }

  /**
   * Probe the candidate proxy by speaking raw HTTP CONNECT to it.
   *
   * Why a raw socket instead of fetch(): Bun's native fetch honors the
   * HTTPS_PROXY env var, but it does NOT surface 407 responses as HTTP
   * status — a 407 with NTLM challenge becomes the opaque "Unable to
   * connect. Is the computer able to access the url?" error. To tell the
   * user *why* the proxy refused us (so we can flag NTLM as unsupported),
   * we open a TCP socket ourselves, send `CONNECT <host>:443`, and parse
   * the proxy's first response line + `Proxy-Authenticate` headers.
   *
   * Target: gstatic.com:443 — Chrome's connectivity-check origin. Almost
   * always whitelisted by corporate proxies because Chrome itself probes
   * it constantly. Real Anthropic / yunwu.ai endpoints are often blocked
   * outright (which would mask an otherwise-working proxy as "broken").
   */
  async testConfig(input: ProxyConfig): Promise<ProxyTestResult> {
    if (!input.enabled || !input.host.trim()) {
      return { ok: false, error: 'Proxy is not configured' }
    }
    const port = input.port
    if (port === null || !Number.isFinite(port) || port <= 0 || port > 65535) {
      return { ok: false, error: 'Proxy port must be 1-65535' }
    }
    const targetHost = 'www.gstatic.com'
    const targetPort = 443
    const started = Date.now()
    return new Promise<ProxyTestResult>((resolve) => {
      let resolved = false
      const finish = (r: ProxyTestResult) => {
        if (resolved) return
        resolved = true
        try { socket.destroy() } catch { /* noop */ }
        resolve(r)
      }
      const socket = net.connect({ host: input.host, port, timeout: 8000 })
      const buffer: Buffer[] = []
      socket.on('timeout', () => finish({
        ok: false,
        latencyMs: Date.now() - started,
        error: `Timed out connecting to proxy ${input.host}:${port}`,
      }))
      socket.on('error', (err) => finish({
        ok: false,
        latencyMs: Date.now() - started,
        error: err.message,
      }))
      socket.on('connect', () => {
        const headers = [
          `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
          `Host: ${targetHost}:${targetPort}`,
          'User-Agent: superai-agent-proxy-test/1.0',
          'Proxy-Connection: close',
        ]
        if (input.username.trim().length > 0) {
          const creds = Buffer.from(`${input.username}:${input.password}`, 'utf-8').toString('base64')
          headers.push(`Proxy-Authorization: Basic ${creds}`)
        }
        socket.write(headers.join('\r\n') + '\r\n\r\n')
      })
      socket.on('data', (chunk) => {
        buffer.push(chunk)
        // First "\r\n\r\n" terminates the CONNECT response head.
        const merged = Buffer.concat(buffer).toString('latin1')
        const headerEnd = merged.indexOf('\r\n\r\n')
        if (headerEnd === -1) return
        finish(parseConnectResponse(merged.slice(0, headerEnd), Date.now() - started))
      })
      socket.on('close', () => {
        // Server closed without a complete response (some proxies do this on
        // refused auth). Use whatever we got.
        if (resolved) return
        const merged = Buffer.concat(buffer).toString('latin1')
        const headerEnd = merged.indexOf('\r\n\r\n')
        if (headerEnd !== -1) {
          finish(parseConnectResponse(merged.slice(0, headerEnd), Date.now() - started))
        } else {
          finish({
            ok: false,
            latencyMs: Date.now() - started,
            error: merged.length > 0
              ? `Proxy closed connection: ${merged.slice(0, 120).trim()}`
              : 'Proxy closed connection without responding',
          })
        }
      })
    })
  }
}

// ─── HTTP CONNECT response parsing ────────────────────────────────────────

/**
 * Ensure NO_PROXY contains loopback entries (localhost, 127.0.0.1, ::1)
 * so the spawned CLI's WebSocket connection back to the local server
 * bypasses the corporate proxy. Preserves any existing user entries.
 */
function mergeNoProxy(existing: unknown): string {
  const required = ['localhost', '127.0.0.1', '::1']
  const current =
    typeof existing === 'string'
      ? existing.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
      : []
  for (const entry of required) {
    if (!current.some((e) => e.toLowerCase() === entry)) {
      current.push(entry)
    }
  }
  return current.join(',')
}

function parseConnectResponse(headBlock: string, latencyMs: number): ProxyTestResult {
  const lines = headBlock.split(/\r?\n/)
  const statusLine = lines[0] ?? ''
  const m = statusLine.match(/^HTTP\/[\d.]+\s+(\d{3})/)
  const status = m ? Number(m[1]) : 0

  if (status >= 200 && status < 300) {
    // Tunnel established — proxy accepted us. Don't actually upgrade to TLS;
    // we already proved what the user needed (auth + reachability).
    return { ok: true, status, latencyMs }
  }

  if (status === 407) {
    const challenges: string[] = []
    for (const line of lines.slice(1)) {
      const hm = line.match(/^Proxy-Authenticate:\s*(.+)$/i)
      if (!hm) continue
      const scheme = hm[1].trim().match(/^([A-Za-z]+)/)
      if (scheme) challenges.push(scheme[1])
    }
    const dedup = [...new Set(challenges)]
    const lower = dedup.map((s) => s.toLowerCase())
    const hint: ProxyTestResult['hint'] = lower.includes('ntlm')
      ? 'ntlm-not-supported'
      : lower.includes('negotiate')
        ? 'negotiate-not-supported'
        : 'auth-required'
    return {
      ok: false,
      status,
      latencyMs,
      authChallenges: dedup,
      hint,
      error: dedup.length
        ? `Proxy requires ${dedup.join(', ')} authentication`
        : 'Proxy returned 407 (authentication required)',
    }
  }

  // 4xx/5xx that isn't 407 — proxy reachable but blocked the destination.
  return {
    ok: false,
    status,
    latencyMs,
    error: status > 0
      ? `Proxy returned HTTP ${status}: ${statusLine.replace(/^HTTP\/[\d.]+\s+\d+\s*/, '').trim()}`
      : `Unrecognized proxy response: ${statusLine.slice(0, 80)}`,
  }
}

export const proxySettingsService = new ProxySettingsService()
