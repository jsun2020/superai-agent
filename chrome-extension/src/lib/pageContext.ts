/**
 * Turns what the extension captured about a tab into the block that is
 * prepended to the user's message. This is the ONLY place the prompt shape is
 * decided, and it is a pure function so the limits can be tested: a page that
 * logs ten thousand errors must still produce a bounded block.
 */

export type ConsoleEntry = {
  level: 'error' | 'warn' | 'info' | 'log' | 'uncaught' | 'unhandledrejection'
  text: string
  ts: number
  /** "file.js:12:3" when the browser told us. */
  source?: string
}

export type NetworkEntry = {
  method: string
  url: string
  /** HTTP status when the request completed; absent for a network-level error. */
  status?: number
  /** Chrome's net error string, e.g. "net::ERR_CONNECTION_REFUSED". */
  error?: string
  /** Chrome resource type: xmlhttprequest, script, image, main_frame ... */
  resourceType?: string
  ts: number
}

export type ElementCapture = {
  /** CSS-ish path such as "main > form#pay > button.primary". */
  path: string
  outerHTML: string
  /** Text content, trimmed. */
  text?: string
}

export type PageSnapshot = {
  url: string
  title: string
  viewport?: { width: number; height: number }
  capturedAt: number
  console: ConsoleEntry[]
  network: NetworkEntry[]
  element?: ElementCapture | null
}

export type ContextLimits = {
  maxConsoleEntries: number
  maxNetworkEntries: number
  maxEntryChars: number
  maxElementChars: number
  maxTotalChars: number
}

export const DEFAULT_LIMITS: ContextLimits = {
  maxConsoleEntries: 30,
  maxNetworkEntries: 20,
  maxEntryChars: 500,
  maxElementChars: 4000,
  maxTotalChars: 16_000,
}

export const CONTEXT_OPEN = '<page-debug-context>'
export const CONTEXT_CLOSE = '</page-debug-context>'

function clip(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}… [+${s.length - max} chars]`
}

function relTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`
}

/** Is a completed request worth reporting? 4xx/5xx or a network error. */
export function isFailedRequest(e: Pick<NetworkEntry, 'status' | 'error'>): boolean {
  if (e.error) return true
  return typeof e.status === 'number' && e.status >= 400
}

/**
 * Build the context block. Returns '' when there is nothing to say, so the
 * caller can send the bare user text unchanged.
 */
export function formatPageContext(
  snapshot: PageSnapshot,
  limits: ContextLimits = DEFAULT_LIMITS,
  now: number = Date.now(),
): string {
  const lines: string[] = []
  lines.push(`URL: ${snapshot.url}`)
  if (snapshot.title) lines.push(`Title: ${clip(snapshot.title, 200)}`)
  if (snapshot.viewport) lines.push(`Viewport: ${snapshot.viewport.width}x${snapshot.viewport.height}`)

  const consoleEntries = snapshot.console.slice(-limits.maxConsoleEntries)
  const dropped = snapshot.console.length - consoleEntries.length
  if (consoleEntries.length > 0) {
    lines.push('')
    lines.push(`Console (${consoleEntries.length} most recent${dropped > 0 ? `, ${dropped} older omitted` : ''}):`)
    for (const c of consoleEntries) {
      const where = c.source ? ` (${c.source})` : ''
      lines.push(`- [${c.level}] ${clip(c.text.replace(/\s+/g, ' ').trim(), limits.maxEntryChars)}${where} — ${relTime(c.ts, now)}`)
    }
  }

  const failed = snapshot.network.filter(isFailedRequest).slice(-limits.maxNetworkEntries)
  const droppedNet = snapshot.network.filter(isFailedRequest).length - failed.length
  if (failed.length > 0) {
    lines.push('')
    lines.push(`Failed requests (${failed.length} most recent${droppedNet > 0 ? `, ${droppedNet} older omitted` : ''}):`)
    for (const n of failed) {
      const outcome = n.error ? n.error : `HTTP ${n.status}`
      const kind = n.resourceType ? ` [${n.resourceType}]` : ''
      lines.push(`- ${n.method} ${clip(n.url, limits.maxEntryChars)} → ${outcome}${kind} — ${relTime(n.ts, now)}`)
    }
  }

  if (snapshot.element) {
    lines.push('')
    lines.push(`Selected element: ${clip(snapshot.element.path, 300)}`)
    if (snapshot.element.text) lines.push(`Text: ${clip(snapshot.element.text.replace(/\s+/g, ' ').trim(), 300)}`)
    lines.push('```html')
    lines.push(clip(snapshot.element.outerHTML, limits.maxElementChars))
    lines.push('```')
  }

  const hasSignal = consoleEntries.length > 0 || failed.length > 0 || !!snapshot.element
  if (!hasSignal) return ''

  let body = lines.join('\n')
  if (body.length > limits.maxTotalChars) {
    body = `${body.slice(0, limits.maxTotalChars)}\n… [context truncated]`
  }
  return `${CONTEXT_OPEN}\n${body}\n${CONTEXT_CLOSE}`
}

/** The message as sent: context block (if any), blank line, the user's text. */
export function composeMessage(userText: string, contextBlock: string): string {
  const text = userText.trim()
  if (!contextBlock) return text
  return `${contextBlock}\n\n${text}`
}

/** Short human summary for the transcript ("3 console, 1 failed request, element"). */
export function summarizeSnapshot(snapshot: PageSnapshot, limits: ContextLimits = DEFAULT_LIMITS): string {
  const parts: string[] = []
  const c = Math.min(snapshot.console.length, limits.maxConsoleEntries)
  const n = Math.min(snapshot.network.filter(isFailedRequest).length, limits.maxNetworkEntries)
  if (c) parts.push(`${c} console`)
  if (n) parts.push(`${n} failed request${n === 1 ? '' : 's'}`)
  if (snapshot.element) parts.push('element')
  return parts.join(', ')
}
