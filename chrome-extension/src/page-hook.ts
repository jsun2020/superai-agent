/**
 * Runs in the page's MAIN world (manifest `world: "MAIN"`), the only place
 * console calls and uncaught errors can be seen. It has no chrome.* access, so
 * it hands entries to the isolated content script via window.postMessage.
 *
 * Kept deliberately small and defensive: it runs on every page the user
 * visits, before the page's own scripts, and must never change their behaviour.
 */

export {}

type Level = 'error' | 'warn' | 'info' | 'log' | 'uncaught' | 'unhandledrejection'

const MARK = '__superai_agent_debug__'
const MAX_TEXT = 2000
const LEVELS: Array<Exclude<Level, 'uncaught' | 'unhandledrejection'>> = ['error', 'warn', 'info']

;(() => {
  const w = window as unknown as Record<string, unknown>
  if (w[MARK]) return
  w[MARK] = true

  const post = (level: Level, text: string, source?: string) => {
    try {
      window.postMessage({ [MARK]: 1, kind: 'console', level, text: text.slice(0, MAX_TEXT), ts: Date.now(), source }, '*')
    } catch {
      // A page with a broken structured-clone target must not break us.
    }
  }

  const describe = (v: unknown): string => {
    if (v instanceof Error) return `${v.name}: ${v.message}${v.stack ? `\n${v.stack.split('\n').slice(1, 4).join('\n')}` : ''}`
    if (typeof v === 'string') return v
    if (v === null || v === undefined || typeof v !== 'object') return String(v)
    try {
      return JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? String(val) : val)).slice(0, MAX_TEXT)
    } catch {
      return Object.prototype.toString.call(v)
    }
  }

  let inHook = false
  for (const level of LEVELS) {
    const original = console[level]
    if (typeof original !== 'function') continue
    console[level] = function (this: unknown, ...args: unknown[]) {
      if (!inHook) {
        inHook = true
        try {
          post(level, args.map(describe).join(' '))
        } finally {
          inHook = false
        }
      }
      return original.apply(this, args)
    }
  }

  window.addEventListener('error', (ev) => {
    const src = ev.filename ? `${ev.filename.split('/').pop()}:${ev.lineno}:${ev.colno}` : undefined
    post('uncaught', ev.error instanceof Error ? describe(ev.error) : String(ev.message), src)
  })

  window.addEventListener('unhandledrejection', (ev) => {
    post('unhandledrejection', describe((ev as PromiseRejectionEvent).reason))
  })
})()
