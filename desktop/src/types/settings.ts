// Source: src/server/api/models.ts, src/server/api/settings.ts

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk'

export type EffortLevel = 'low' | 'medium' | 'high' | 'max'
export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'
// Product mode: 'work' = general office users, 'code' = developers (default).
export type AppMode = 'work' | 'code'
// Optional workplace role within Work mode, chosen per session on the new
// session screen. Mirrors SessionRole in src/server/services/workMode.ts.
// No 'office' role: no role at all is the document experience.
export type SessionRole = 'assistant' | 'sales' | 'analyst'
export const SESSION_ROLES: readonly SessionRole[] = ['assistant', 'sales', 'analyst'] as const

export type ModelInfo = {
  id: string
  name: string
  description: string
  context: string
}

export type UserSettings = {
  model?: string
  modelContext?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
  theme?: ThemeMode
  skipWebFetchPreflight?: boolean
  [key: string]: unknown
}

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
  authChallenges?: string[]
  hint?: 'ntlm-not-supported' | 'negotiate-not-supported' | 'auth-required'
}
