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
import { ApiError } from '../middleware/errorHandler.js'
import { request as undiciRequest, ProxyAgent } from 'undici'

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
    } else {
      const url = this.buildProxyUrl(input)
      env.HTTPS_PROXY = url
      env.HTTP_PROXY = url
    }

    settings.env = env
    await this.writeSettings(settings)

    // Apply to current process so the sidecar's own outgoing calls
    // (e.g. provider test endpoints) start using the new proxy without
    // an app restart. Spawned CLI subprocesses still need a session
    // restart because they inherited env at spawn time.
    if (env.HTTPS_PROXY) {
      process.env.HTTPS_PROXY = String(env.HTTPS_PROXY)
      process.env.HTTP_PROXY = String(env.HTTP_PROXY ?? env.HTTPS_PROXY)
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
   * Probe the candidate proxy by issuing a small HTTPS request through it.
   * Default target: api.anthropic.com (returns 401 quickly without a key,
   * which is enough to prove the tunnel is up).
   */
  async testConfig(input: ProxyConfig): Promise<ProxyTestResult> {
    if (!input.enabled || !input.host.trim()) {
      return { ok: false, error: 'Proxy is not configured' }
    }
    let url: string
    try {
      url = this.buildProxyUrl(input)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    const target = 'https://api.anthropic.com/v1/models'
    const started = Date.now()
    try {
      const dispatcher = new ProxyAgent({
        uri: url,
        connectTimeout: 8000,
        bodyTimeout: 8000,
        headersTimeout: 8000,
      })
      const res = await undiciRequest(target, {
        method: 'GET',
        dispatcher,
        headers: { 'user-agent': 'superai-agent-proxy-test/1.0' },
      })
      const latency = Date.now() - started
      // any status (including 401/403) means we tunneled successfully
      await res.body.dump()
      return { ok: true, status: res.statusCode, latencyMs: latency }
    } catch (err) {
      const latency = Date.now() - started
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, latencyMs: latency, error: message }
    }
  }
}

export const proxySettingsService = new ProxySettingsService()
