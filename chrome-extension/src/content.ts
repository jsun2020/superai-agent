/**
 * Isolated-world content script: the bridge between the page and the
 * extension. Relays console entries from the MAIN-world hook to the
 * background, remembers the last right-clicked element for the context menu,
 * and answers the background's questions about the page.
 */

// A module, so its top-level names do not share TypeScript's global scope
// with page-hook.ts (bundled to a classic script regardless).
export {}

const MARK = '__superai_agent_debug__'
const MAX_OUTER_HTML = 8000

let lastContextElement: Element | null = null

// Console entries from page-hook.ts (same window, marked payload only).
window.addEventListener('message', (ev) => {
  if (ev.source !== window) return
  const data = ev.data as Record<string, unknown> | null
  if (!data || data[MARK] !== 1 || data.kind !== 'console') return
  try {
    void chrome.runtime.sendMessage({
      type: 'console',
      entry: { level: data.level, text: data.text, ts: data.ts, source: data.source },
    })
  } catch {
    // Extension reloaded underneath us; the next page load reconnects.
  }
})

// Remember what the user right-clicked so "Ask SuperAI Agent about this
// element" can describe it. Capture phase, so pages that stop propagation
// cannot hide it.
document.addEventListener(
  'contextmenu',
  (ev) => {
    lastContextElement = ev.target instanceof Element ? ev.target : null
  },
  true,
)

function cssPath(el: Element): string {
  const parts: string[] = []
  let cur: Element | null = el
  while (cur && cur !== document.documentElement && parts.length < 8) {
    let part = cur.tagName.toLowerCase()
    if (cur.id) {
      parts.unshift(`${part}#${cur.id}`)
      break
    }
    const classes = Array.from(cur.classList).slice(0, 2)
    if (classes.length) part += `.${classes.join('.')}`
    const parent: Element | null = cur.parentElement
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName)
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`
    }
    parts.unshift(part)
    cur = parent
  }
  return parts.join(' > ')
}

function describeElement(el: Element) {
  const html = el.outerHTML
  return {
    path: cssPath(el),
    outerHTML: html.length > MAX_OUTER_HTML ? `${html.slice(0, MAX_OUTER_HTML)}… [+${html.length - MAX_OUTER_HTML} chars]` : html,
    text: (el.textContent ?? '').trim().slice(0, 300),
  }
}

chrome.runtime.onMessage.addListener((msg: { type?: string }, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'getElement':
      sendResponse(lastContextElement ? describeElement(lastContextElement) : null)
      return false
    case 'getPageInfo':
      sendResponse({
        url: location.href,
        title: document.title,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      })
      return false
    default:
      return false
  }
})
