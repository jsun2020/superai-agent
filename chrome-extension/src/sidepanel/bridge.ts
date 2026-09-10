/** Typed calls from the side panel to the background service worker. */

import type { PageSnapshot } from '../lib/pageContext'

function call<T>(msg: Record<string, unknown>): Promise<T> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => resolve(res as T))
    } catch {
      resolve(undefined as T)
    }
  })
}

export type ActiveTab = { id: number; windowId: number; url?: string; title?: string } | null

export const bg = {
  getActiveTab: () => call<ActiveTab>({ type: 'getActiveTab' }),
  getSnapshot: (tabId: number) => call<PageSnapshot | null>({ type: 'getSnapshot', tabId }),
  clearSnapshot: (tabId: number) => call<boolean>({ type: 'clearSnapshot', tabId }),
  clearElement: (tabId: number) => call<boolean>({ type: 'clearElement', tabId }),
  captureScreenshot: (windowId: number) => call<{ dataUrl?: string; error?: string }>({ type: 'captureScreenshot', windowId }),
}

export type Settings = { serverUrl: string; workDir: string; attachContext: boolean }
export const DEFAULT_SETTINGS: Settings = { serverUrl: 'http://127.0.0.1:3456', workDir: '', attachContext: true }

export async function loadSettings(): Promise<Settings> {
  try {
    const got = await chrome.storage.local.get('settings')
    return { ...DEFAULT_SETTINGS, ...((got.settings as Partial<Settings>) ?? {}) }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  try {
    await chrome.storage.local.set({ settings: s })
  } catch {
    // storage unavailable; settings live for this panel only
  }
}

/** One conversation per browser window, remembered for the browser session. */
export async function loadSessionId(windowId: number): Promise<string | null> {
  try {
    const got = await chrome.storage.session.get(`session:${windowId}`)
    return (got[`session:${windowId}`] as string) ?? null
  } catch {
    return null
  }
}

export async function saveSessionId(windowId: number, sessionId: string | null): Promise<void> {
  try {
    if (sessionId) await chrome.storage.session.set({ [`session:${windowId}`]: sessionId })
    else await chrome.storage.session.remove(`session:${windowId}`)
  } catch {
    // ignore
  }
}
