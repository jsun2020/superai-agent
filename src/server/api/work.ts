/**
 * Work-mode catalog API — read-only views over ~/.superai.
 *
 * GET  /api/work/home                    — { path } of the folder, for the UI to point at
 * GET  /api/work/roles                   — { roles }      (prompt bodies omitted)
 * GET  /api/work/connectors              — { connectors } (config templates omitted)
 * POST /api/work/connectors/:id/render   — { values } -> { config } ready for mcp createServer
 *
 * There is intentionally no PUT/DELETE: the files are the editing surface,
 * and the README in the folder explains them. An editor in the UI can come
 * later without changing this contract.
 */

import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { getSuperaiHome } from '../services/superaiHome.js'
import {
  findConnector,
  loadConnectors,
  renderConnectorConfig,
  type ConnectorFormValues,
} from '../services/workConnectors.js'
import { loadWorkRoles } from '../services/workRoles.js'

export async function handleWorkApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const resource = segments[2]

    if (resource === 'home' && req.method === 'GET') {
      return Response.json({ path: getSuperaiHome() })
    }

    if (resource === 'roles' && req.method === 'GET') {
      // The desktop never needs the prompt text; leaving it out keeps a
      // user's role file from being echoed to every session-picker render.
      const roles = loadWorkRoles().map(({ prompt: _prompt, ...role }) => role)
      return Response.json({ roles })
    }

    if (resource === 'connectors') {
      const id = segments[3] ? decodeURIComponent(segments[3]) : undefined

      if (!id && req.method === 'GET') {
        const connectors = loadConnectors().map(({ config: _config, ...connector }) => connector)
        return Response.json({ connectors })
      }

      if (id && segments[4] === 'render' && req.method === 'POST') {
        const connector = findConnector(id)
        if (!connector) throw ApiError.notFound(`Unknown connector: ${id}`)
        if (!connector.config) {
          throw ApiError.badRequest(`Connector "${id}" is not connectable yet`)
        }
        const body = (await req.json().catch(() => ({}))) as { values?: unknown }
        const values = sanitizeValues(body.values)
        return Response.json({ config: renderConnectorConfig(connector.config, values) })
      }
    }

    throw ApiError.notFound(`Unknown work resource: ${segments.slice(2).join('/')}`)
  } catch (error) {
    return errorResponse(error)
  }
}

/** Only strings and booleans reach the renderer; anything else is dropped. */
function sanitizeValues(input: unknown): ConnectorFormValues {
  const out: ConnectorFormValues = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'boolean') out[key] = value
  }
  return out
}
