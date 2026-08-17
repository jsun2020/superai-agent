import { api } from './client'
import type { McpEditableConfig } from '../types/mcp'
import type { Connector, ConnectorFieldValue, WorkRole } from '../types/work'

/**
 * Work-mode catalog, read-only. Everything here is a file in ~/.superai;
 * the folder is the editing surface, so there are no write endpoints.
 */
export const workApi = {
  home: () => api.get<{ path: string }>('/api/work/home'),
  roles: () => api.get<{ roles: WorkRole[] }>('/api/work/roles'),
  connectors: () => api.get<{ connectors: Connector[] }>('/api/work/connectors'),
  /**
   * Turn a connector's form values into the MCP config to hand to
   * mcpStore.createServer. Rendered server-side so the template format has one
   * implementation, next to its docs and its tests.
   */
  renderConnector: (id: string, values: Record<string, ConnectorFieldValue>) =>
    api.post<{ config: McpEditableConfig }>(
      `/api/work/connectors/${encodeURIComponent(id)}/render`,
      { values },
    ),
}
