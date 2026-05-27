import { create } from 'zustand'
import type { ThemeMode, ResolvedTheme } from '../types/settings'

const THEME_STORAGE_KEY = 'superai-agent-theme'

function getStoredTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch { /* localStorage unavailable */ }
  return 'system'
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function resolveTheme(theme: ThemeMode): ResolvedTheme {
  return theme === 'system' ? getSystemTheme() : theme
}

export function applyTheme(theme: ThemeMode) {
  if (typeof document === 'undefined') return
  const resolved = resolveTheme(theme)
  document.documentElement.setAttribute('data-theme', resolved)
  document.documentElement.style.colorScheme = resolved
}

let mediaListenerInstalled = false

export function initializeTheme() {
  applyTheme(getStoredTheme())
  if (mediaListenerInstalled) return
  if (typeof window === 'undefined' || !window.matchMedia) return
  const mql = window.matchMedia('(prefers-color-scheme: dark)')
  const onChange = () => {
    if (useUIStore.getState().theme === 'system') {
      applyTheme('system')
    }
  }
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', onChange)
  } else if (typeof mql.addListener === 'function') {
    mql.addListener(onChange)
  }
  mediaListenerInstalled = true
}

export type Toast = {
  id: string
  type: 'success' | 'error' | 'warning' | 'info'
  message: string
  duration?: number
}

export type SettingsTab =
  | 'providers'
  | 'permissions'
  | 'general'
  | 'adapters'
  | 'terminal'
  | 'mcp'
  | 'agents'
  | 'skills'
  | 'plugins'
  | 'computerUse'
  | 'about'

type ActiveView = 'code' | 'scheduled' | 'terminal' | 'history' | 'settings'

type UIStore = {
  theme: ThemeMode
  sidebarOpen: boolean
  activeView: ActiveView
  pendingSettingsTab: SettingsTab | null
  pendingTerminalCommand: string | null
  activeModal: string | null
  toasts: Toast[]

  setTheme: (theme: ThemeMode) => void
  toggleTheme: () => void
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
  setActiveView: (view: ActiveView) => void
  setPendingSettingsTab: (tab: SettingsTab | null) => void
  setPendingTerminalCommand: (command: string | null) => void
  openModal: (id: string) => void
  closeModal: () => void
  addToast: (toast: Omit<Toast, 'id'>) => void
  removeToast: (id: string) => void
}

let toastCounter = 0

export const useUIStore = create<UIStore>((set) => ({
  theme: getStoredTheme(),
  sidebarOpen: true,
  activeView: 'code',
  pendingSettingsTab: null,
  pendingTerminalCommand: null,
  activeModal: null,
  toasts: [],

  setTheme: (theme) => {
    applyTheme(theme)
    try { localStorage.setItem(THEME_STORAGE_KEY, theme) } catch { /* noop */ }
    set({ theme })
  },

  toggleTheme: () => {
    set((state) => {
      const current = resolveTheme(state.theme)
      const next: ThemeMode = current === 'light' ? 'dark' : 'light'
      applyTheme(next)
      try { localStorage.setItem(THEME_STORAGE_KEY, next) } catch { /* noop */ }
      return { theme: next }
    })
  },

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setActiveView: (view) => set({ activeView: view }),
  setPendingSettingsTab: (tab) => set({ pendingSettingsTab: tab }),
  setPendingTerminalCommand: (command) => set({ pendingTerminalCommand: command }),
  openModal: (id) => set({ activeModal: id }),
  closeModal: () => set({ activeModal: null }),

  addToast: (toast) => {
    const id = `toast-${++toastCounter}`
    set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }))
    // Auto-remove after duration
    const duration = toast.duration ?? 4000
    if (duration > 0) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
      }, duration)
    }
  },

  removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))
