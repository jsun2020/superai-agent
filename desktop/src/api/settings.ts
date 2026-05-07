import { api } from './client'
import type { PermissionMode, UserSettings, ProxyConfig, ProxyTestResult } from '../types/settings'

export type CliLauncherStatus = {
  supported: boolean
  command: string
  installed: boolean
  launcherPath: string
  binDir: string
  pathConfigured: boolean
  pathInCurrentShell: boolean
  availableInNewTerminals: boolean
  needsTerminalRestart: boolean
  configTarget: string | null
  lastError: string | null
}

export const settingsApi = {
  getUser() {
    return api.get<UserSettings>('/api/settings/user')
  },

  updateUser(settings: Partial<UserSettings>) {
    return api.put<{ ok: true }>('/api/settings/user', settings)
  },

  getPermissionMode() {
    return api.get<{ mode: PermissionMode }>('/api/permissions/mode')
  },

  setPermissionMode(mode: PermissionMode) {
    return api.put<{ ok: true; mode: PermissionMode }>('/api/permissions/mode', { mode })
  },

  getCliLauncherStatus() {
    return api.get<CliLauncherStatus>('/api/settings/cli-launcher')
  },

  getProxy() {
    return api.get<ProxyConfig>('/api/settings/proxy')
  },

  setProxy(config: ProxyConfig) {
    return api.put<{ ok: true }>('/api/settings/proxy', config)
  },

  testProxy(config: ProxyConfig) {
    return api.post<ProxyTestResult>('/api/settings/proxy/test', config)
  },
}
