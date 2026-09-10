/**
 * Service worker: owns the per-tab debug buffers and answers the side panel.
 *
 * Buffers are bounded and cleared on main-frame navigation. Because MV3
 * workers are killed when idle, buffers are mirrored to chrome.storage.session
 * (debounced) and restored on wake, so a page's errors survive the worker's
 * lifetime but not the browser's.
 */

import type { ConsoleEntry, ElementCapture, NetworkEntry, PageSnapshot } from './lib/pageContext'

type TabBuffers = { console: ConsoleEntry[]; network: NetworkEntry[]; element: ElementCapture | null }

const MAX_CONSOLE = 200
const MAX_NETWORK = 100
const MENU_ID = 'superai-agent-ask-element'

const buffers = new Map<number, TabBuffers>()
let restored: Promise<void> | null = null

function key(tabId: number) {
  return `tab:${tabId}`
}

async function restore(): Promise<void> {
  if (!restored) {
    restored = (async () => {
      const all = await chrome.storage.session.get(null)
      for (const [k, v] of Object.entries(all)) {
        const m = /^tab:(\d+)$/.exec(k)
        if (m) buffers.set(Number(m[1]), v as TabBuffers)
      }
    })().catch(() => {})
  }
  return restored
}

const dirty = new Set<number>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
function persist(tabId: number) {
  dirty.add(tabId)
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    const batch: Record<string, TabBuffers> = {}
    for (const id of dirty) {
      const b = buffers.get(id)
      if (b) batch[key(id)] = b
    }
    dirty.clear()
    void chrome.storage.session.set(batch).catch(() => {})
  }, 500)
}

function bucket(tabId: number): TabBuffers {
  let b = buffers.get(tabId)
  if (!b) {
    b = { console: [], network: [], element: null }
    buffers.set(tabId, b)
  }
  return b
}

function clearTab(tabId: number) {
  buffers.delete(tabId)
  void chrome.storage.session.remove(key(tabId)).catch(() => {})
}

// ─── Capture ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: { type?: string; [k: string]: unknown }, sender, sendResponse) => {
  void restore().then(async () => {
    switch (msg?.type) {
      case 'console': {
        const tabId = sender.tab?.id
        if (tabId === undefined) return sendResponse(false)
        const b = bucket(tabId)
        b.console.push(msg.entry as ConsoleEntry)
        if (b.console.length > MAX_CONSOLE) b.console.splice(0, b.console.length - MAX_CONSOLE)
        persist(tabId)
        return sendResponse(true)
      }
      case 'getActiveTab': {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
        return sendResponse(tab ? { id: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title } : null)
      }
      case 'getSnapshot': {
        const tabId = Number(msg.tabId)
        const snap = await snapshot(tabId)
        return sendResponse(snap)
      }
      case 'clearSnapshot': {
        clearTab(Number(msg.tabId))
        return sendResponse(true)
      }
      case 'clearElement': {
        const b = buffers.get(Number(msg.tabId))
        if (b) {
          b.element = null
          persist(Number(msg.tabId))
        }
        return sendResponse(true)
      }
      case 'captureScreenshot': {
        try {
          const dataUrl = await chrome.tabs.captureVisibleTab(Number(msg.windowId), { format: 'jpeg', quality: 70 })
          return sendResponse({ dataUrl })
        } catch (e) {
          return sendResponse({ error: e instanceof Error ? e.message : String(e) })
        }
      }
      default:
        return sendResponse(undefined)
    }
  })
  return true // async sendResponse
})

async function snapshot(tabId: number): Promise<PageSnapshot | null> {
  let tab: chrome.tabs.Tab
  try {
    tab = await chrome.tabs.get(tabId)
  } catch {
    return null
  }
  // Page-side facts (viewport, live title) when the content script is
  // reachable; chrome:// and the Web Store are not, and that is fine.
  let info: { url?: string; title?: string; viewport?: { width: number; height: number } } = {}
  try {
    info = (await chrome.tabs.sendMessage(tabId, { type: 'getPageInfo' })) ?? {}
  } catch {
    // no content script on this page
  }
  const b = bucket(tabId)
  return {
    url: info.url ?? tab.url ?? '',
    title: info.title ?? tab.title ?? '',
    ...(info.viewport ? { viewport: info.viewport } : {}),
    capturedAt: Date.now(),
    console: [...b.console],
    network: [...b.network],
    element: b.element,
  }
}

// Failed requests: network-level errors and HTTP 4xx/5xx. Everything else is
// noise for a debugging session and is not kept.
chrome.webRequest.onErrorOccurred.addListener(
  (d) => {
    if (d.tabId < 0) return
    void restore().then(() => {
      const b = bucket(d.tabId)
      b.network.push({ method: d.method, url: d.url, error: d.error, resourceType: d.type, ts: d.timeStamp })
      if (b.network.length > MAX_NETWORK) b.network.splice(0, b.network.length - MAX_NETWORK)
      persist(d.tabId)
    })
  },
  { urls: ['<all_urls>'] },
)

chrome.webRequest.onCompleted.addListener(
  (d) => {
    if (d.tabId < 0 || d.statusCode < 400) return
    void restore().then(() => {
      const b = bucket(d.tabId)
      b.network.push({ method: d.method, url: d.url, status: d.statusCode, resourceType: d.type, ts: d.timeStamp })
      if (b.network.length > MAX_NETWORK) b.network.splice(0, b.network.length - MAX_NETWORK)
      persist(d.tabId)
    })
  },
  { urls: ['<all_urls>'] },
)

// A new document in the main frame starts a fresh buffer: "reload and look
// again" must show this load's errors, not the last hour's.
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0) clearTab(d.tabId)
})

chrome.tabs.onRemoved.addListener((tabId) => clearTab(tabId))

// ─── Context menu + side panel ─────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU_ID, title: 'Ask SuperAI Agent about this element', contexts: ['all'] })
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return
  const tabId = tab.id
  void (async () => {
    await restore()
    // Open first: sidePanel.open needs the user gesture that is still live here.
    if (tab.windowId !== undefined) {
      await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {})
    }
    try {
      const el = (await chrome.tabs.sendMessage(tabId, { type: 'getElement' })) as ElementCapture | null
      bucket(tabId).element = el
      persist(tabId)
      void chrome.runtime.sendMessage({ type: 'elementCaptured', tabId, element: el }).catch(() => {})
    } catch {
      // No content script on this page (chrome://, PDF viewer, ...).
    }
  })()
})
