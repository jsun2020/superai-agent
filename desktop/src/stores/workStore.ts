import { create } from 'zustand'
import { workApi } from '../api/work'
import type { Connector, WorkRole } from '../types/work'

type WorkStore = {
  homePath: string | null
  roles: WorkRole[]
  connectors: Connector[]
  rolesLoaded: boolean
  connectorsLoaded: boolean
  error: string | null
  fetchHome: () => Promise<void>
  fetchRoles: () => Promise<void>
  fetchConnectors: () => Promise<void>
}

/**
 * The Work-mode catalog as served from ~/.superai. Fetched on demand by the
 * screens that show it; there is no cache invalidation because the server
 * reads the folder fresh on every request — re-fetching IS the refresh.
 */
export const useWorkStore = create<WorkStore>((set) => ({
  homePath: null,
  roles: [],
  connectors: [],
  rolesLoaded: false,
  connectorsLoaded: false,
  error: null,

  fetchHome: async () => {
    try {
      const { path } = await workApi.home()
      set({ homePath: path })
    } catch {
      // Purely informational (a hint under the catalog); never worth an error.
    }
  },

  fetchRoles: async () => {
    try {
      const { roles } = await workApi.roles()
      set({ roles, rolesLoaded: true, error: null })
    } catch (error) {
      set({ rolesLoaded: true, error: error instanceof Error ? error.message : String(error) })
    }
  },

  fetchConnectors: async () => {
    try {
      const { connectors } = await workApi.connectors()
      set({ connectors, connectorsLoaded: true, error: null })
    } catch (error) {
      set({
        connectorsLoaded: true,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },
}))
