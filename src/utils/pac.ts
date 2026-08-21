/**
 * Proxy auto-configuration (PAC) support.
 *
 * Windows machines in managed fleets are commonly configured with an
 * `AutoConfigURL` pointing at a PAC script rather than a static proxy — and
 * Windows honours that script EVEN WHEN `ProxyEnable` is 0, so a machine that
 * reads as "no proxy" in the registry is in fact fully proxied. Every browser
 * and Office app evaluates the script; an app that only understands a static
 * proxy goes direct instead, straight into whatever transparent appliance sits
 * on the path, and receives its HTML block page.
 *
 * A PAC script is JavaScript exposing `FindProxyForURL(url, host)` which
 * returns a directive such as `"PROXY p.corp:8080; DIRECT"`. It is evaluated
 * here in a `node:vm` sandbox with only the standard PAC helper functions in
 * scope — no `require`, no `process`, no `fetch` — and a hard execution
 * timeout, because the script is remote code even though it is the OS's own
 * configuration.
 *
 * Known limitation: `dnsResolve`/`isResolvable` are synchronous in the PAC
 * spec but DNS is async in JS. We pre-resolve the target host before entering
 * the sandbox and answer from that; a lookup of any OTHER host returns null.
 * This covers the overwhelmingly common `isInNet(dnsResolve(host), ...)`
 * shape and is documented rather than silently wrong.
 */
import vm from 'node:vm'
import os from 'node:os'
import { logForDebugging } from './debug.js'

export type PacResolution = {
  /** Raw directive the script returned, e.g. "PROXY p.corp:8080; DIRECT". */
  directive: string
  /** Proxy URL to use, or null when the script chose DIRECT. */
  proxyUrl: string | null
}

/** PAC scripts are small; anything larger is not a PAC and must not be run. */
const MAX_PAC_BYTES = 1024 * 1024
/**
 * Bounded tightly because this is awaited during startup: a machine whose PAC
 * URL is unreachable must fall back to direct quickly rather than stall the
 * app. Such a machine is already broken for every other app on it.
 */
const PAC_FETCH_TIMEOUT_MS = 8_000
/** A hostile or buggy PAC must not be able to hang startup. */
const PAC_EVAL_TIMEOUT_MS = 1_000

// ─── IPv4 helpers (shared by isInNet / myIpAddress) ────────────────────────

function ipToInt(ip: string): number | null {
  const parts = ip.trim().split('.')
  if (parts.length !== 4) return null
  let out = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    out = (out << 8) | n
  }
  return out >>> 0
}

/** First non-internal IPv4 address, matching what a PAC's myIpAddress() means. */
export function firstLocalIPv4(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string {
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      // Node <18 reports family as 'IPv4', newer as 4 — accept both.
      const isV4 = info.family === 'IPv4' || (info.family as unknown as number) === 4
      if (isV4 && !info.internal) return info.address
    }
  }
  return '127.0.0.1'
}

/** Translate a PAC shell expression (`*.corp.com`, `10.*`) into a regex. */
export function shExpToRegExp(shexp: string): RegExp {
  let out = ''
  for (const ch of shexp) {
    if (ch === '*') out += '.*'
    else if (ch === '?') out += '.'
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

// ─── the sandbox ───────────────────────────────────────────────────────────

export type PacDnsAnswers = {
  /** host -> IPv4, pre-resolved before entering the sandbox. */
  resolved: Record<string, string | null>
  myIp: string
}

/**
 * Build the standard PAC helper functions. Exported so the tests can exercise
 * them directly rather than only through a script.
 */
export function buildPacHelpers(dns: PacDnsAnswers): Record<string, unknown> {
  const dnsResolve = (host: string): string | null => {
    if (!host) return null
    if (ipToInt(host) !== null) return host
    return dns.resolved[host.toLowerCase()] ?? null
  }

  return {
    isPlainHostName: (host: string) => !String(host).includes('.'),
    dnsDomainIs: (host: string, domain: string) =>
      String(host).toLowerCase().endsWith(String(domain).toLowerCase()),
    localHostOrDomainIs: (host: string, hostdom: string) => {
      const h = String(host).toLowerCase()
      const hd = String(hostdom).toLowerCase()
      return h === hd || hd.startsWith(`${h}.`)
    },
    dnsDomainLevels: (host: string) => String(host).split('.').length - 1,
    shExpMatch: (str: string, shexp: string) => {
      try {
        return shExpToRegExp(String(shexp)).test(String(str))
      } catch {
        return false
      }
    },
    dnsResolve,
    isResolvable: (host: string) => dnsResolve(String(host)) !== null,
    myIpAddress: () => dns.myIp,
    isInNet: (hostOrIp: string, pattern: string, mask: string) => {
      const ip = dnsResolve(String(hostOrIp))
      if (!ip) return false
      const a = ipToInt(ip)
      const b = ipToInt(String(pattern))
      const m = ipToInt(String(mask))
      if (a === null || b === null || m === null) return false
      return ((a & m) >>> 0) === ((b & m) >>> 0)
    },
    // Time-based predicates are rare in corporate PACs. Implemented rather
    // than stubbed to false, which would silently change routing.
    weekdayRange: (from: string, to?: string) => {
      const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
      const today = days[new Date().getDay()]!
      const start = days.indexOf(String(from).toUpperCase())
      if (start === -1) return false
      const endName = to && days.includes(String(to).toUpperCase()) ? String(to).toUpperCase() : from
      const end = days.indexOf(String(endName).toUpperCase())
      const cur = days.indexOf(today)
      return start <= end ? cur >= start && cur <= end : cur >= start || cur <= end
    },
    dateRange: () => true,
    timeRange: () => true,
    alert: () => {},
  }
}

/**
 * Run a PAC script's FindProxyForURL in a sandbox and return its raw directive.
 * Throws when the script is malformed, times out, or returns a non-string.
 */
export function evaluatePacScript(
  script: string,
  url: string,
  host: string,
  dns: PacDnsAnswers,
): string {
  // Arguments are passed as context globals rather than interpolated into the
  // source, so a hostile hostname cannot break out into the script text.
  const sandbox: Record<string, unknown> = {
    ...buildPacHelpers(dns),
    __pacResult: undefined,
    __pacUrl: url,
    __pacHost: host,
  }
  const context = vm.createContext(sandbox)
  vm.runInContext(script, context, { timeout: PAC_EVAL_TIMEOUT_MS })
  vm.runInContext('__pacResult = FindProxyForURL(__pacUrl, __pacHost)', context, {
    timeout: PAC_EVAL_TIMEOUT_MS,
  })
  const result = sandbox.__pacResult
  if (typeof result !== 'string') {
    throw new Error(`FindProxyForURL returned ${typeof result}, expected a string`)
  }
  return result
}

/**
 * Turn a PAC directive into a proxy URL this app can actually use.
 *
 * Entries are tried in order. SOCKS entries are skipped: Bun's fetch proxy
 * speaks HTTP CONNECT, so pointing it at a SOCKS port fails in a far more
 * confusing way than continuing to the next entry. DIRECT yields null.
 */
export function parsePacDirective(directive: string): string | null {
  for (const rawEntry of directive.split(';')) {
    const entry = rawEntry.trim()
    if (!entry) continue
    const [keywordRaw, ...rest] = entry.split(/\s+/)
    const keyword = (keywordRaw ?? '').toUpperCase()
    const endpoint = rest.join('')

    if (keyword === 'DIRECT') return null
    if (!endpoint) continue
    if (keyword === 'PROXY' || keyword === 'HTTP') return `http://${endpoint}`
    if (keyword === 'HTTPS') return `https://${endpoint}`
    // SOCKS / SOCKS4 / SOCKS5 / anything unknown: try the next entry.
  }
  return null
}

/** Fetch a PAC script, bounded in both time and size. */
export async function fetchPacScript(
  pacUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PAC_FETCH_TIMEOUT_MS)
  try {
    const response = await fetchImpl(pacUrl, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`PAC fetch returned HTTP ${response.status}`)
    }
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (declared > MAX_PAC_BYTES) {
      throw new Error(`PAC script is ${declared} bytes, over the ${MAX_PAC_BYTES} limit`)
    }
    const text = await response.text()
    if (text.length > MAX_PAC_BYTES) {
      throw new Error(`PAC script is ${text.length} bytes, over the ${MAX_PAC_BYTES} limit`)
    }
    return text
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Full resolution: fetch the PAC, pre-resolve the target host for the sandbox's
 * dnsResolve, evaluate, and translate the directive into a proxy URL.
 */
export async function resolveProxyViaPac(opts: {
  pacUrl: string
  targetUrl: string
  fetchImpl?: typeof fetch
  lookup?: (host: string) => Promise<string | null>
}): Promise<PacResolution> {
  const { pacUrl, targetUrl, fetchImpl = fetch } = opts
  const host = new URL(targetUrl).hostname
  const script = await fetchPacScript(pacUrl, fetchImpl)

  const lookup = opts.lookup ?? defaultLookup
  const resolved: Record<string, string | null> = {}
  resolved[host.toLowerCase()] = await lookup(host).catch(() => null)

  const directive = evaluatePacScript(script, targetUrl, host, {
    resolved,
    myIp: firstLocalIPv4(),
  })
  return { directive, proxyUrl: parsePacDirective(directive) }
}

/** Loopback must bypass the proxy: the CLI subprocess dials ws://127.0.0.1. */
function mergeLoopbackIntoNoProxy(existing: string | undefined): string {
  const entries = (existing ?? '')
    .split(/[,\s]+/)
    .map(s => s.trim())
    .filter(Boolean)
  for (const required of ['localhost', '127.0.0.1', '::1']) {
    if (!entries.some(e => e.toLowerCase() === required)) entries.push(required)
  }
  return entries.join(',')
}

/**
 * Apply the machine's PAC script, if the desktop shell found one, so a
 * PAC-configured machine needs no manual proxy setup at all.
 *
 * Called during init BEFORE configureGlobalAgents(), because the proxy it
 * discovers must be in process.env by the time agents and fetch options are
 * built. Returns the resolution for logging, or null when nothing was applied.
 *
 * Failure is never fatal: if the PAC cannot be fetched or evaluated we leave
 * the environment exactly as it was, which is the behaviour that shipped
 * before this existed.
 */
export async function applySystemPacProxy(
  env: Record<string, string | undefined> = process.env,
): Promise<PacResolution | null> {
  const pacUrl = env.SUPERAI_PAC_URL?.trim()
  if (!pacUrl) return null

  // An explicit proxy always wins - the user typed it into Settings, or IT
  // exported it into the environment. Never override a deliberate choice.
  const explicit = env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY
  if (explicit?.trim()) {
    logForDebugging('PAC skipped: an explicit proxy is already configured', { level: 'debug' })
    return null
  }

  const targetUrl = env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com'
  try {
    const resolution = await resolveProxyViaPac({ pacUrl, targetUrl })
    if (resolution.proxyUrl) {
      env.HTTPS_PROXY = resolution.proxyUrl
      env.HTTP_PROXY = resolution.proxyUrl
      env.NO_PROXY = mergeLoopbackIntoNoProxy(env.NO_PROXY ?? env.no_proxy)
      env.SUPERAI_PROXY_SOURCE = 'pac'
      logForDebugging(
        `PAC ${pacUrl} routed ${targetUrl} via ${resolution.proxyUrl} (${resolution.directive})`,
        { level: 'info' },
      )
    } else {
      // The script explicitly chose DIRECT for this host. That is an answer,
      // not a failure - record it so the error diagnostics can say so.
      env.SUPERAI_PROXY_SOURCE = 'pac-direct'
      logForDebugging(`PAC ${pacUrl} chose DIRECT for ${targetUrl}`, { level: 'info' })
    }
    return resolution
  } catch (err) {
    env.SUPERAI_PROXY_SOURCE = 'pac-failed'
    logForDebugging(`PAC ${pacUrl} could not be applied: ${err}`, { level: 'warn' })
    return null
  }
}

async function defaultLookup(host: string): Promise<string | null> {
  try {
    const { lookup } = await import('node:dns/promises')
    const res = await lookup(host, { family: 4 })
    return res.address
  } catch (err) {
    logForDebugging(`PAC dnsResolve(${host}) failed: ${err}`, { level: 'debug' })
    return null
  }
}
