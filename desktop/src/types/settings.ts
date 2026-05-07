// Source: src/server/api/models.ts, src/server/api/settings.ts

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk'

export type EffortLevel = 'low' | 'medium' | 'high' | 'max'
export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

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
}
