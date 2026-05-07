/**
 * Settings REST API
 *
 * GET  /api/settings            — 获取合并后的设置
 * GET  /api/settings/user       — 获取用户设置
 * GET  /api/settings/project    — 获取项目设置
 * PUT  /api/settings/user       — 更新用户设置
 * PUT  /api/settings/project    — 更新项目设置
 * GET  /api/settings/proxy      — 获取网络代理配置
 * PUT  /api/settings/proxy      — 更新网络代理配置
 * POST /api/settings/proxy/test — 测试代理连通性
 * GET  /api/permissions/mode    — 获取权限模式
 * PUT  /api/permissions/mode    — 设置权限模式
 */

import { SettingsService } from '../services/settingsService.js'
import { proxySettingsService, type ProxyConfig } from '../services/proxySettingsService.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { ensureDesktopCliLauncherInstalled } from '../services/desktopCliLauncherService.js'

const settingsService = new SettingsService()

export async function handleSettingsApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const resource = segments[1] // 'settings' | 'permissions'
    const sub = segments[2] // 'user' | 'project' | 'mode' | undefined

    // ── /api/permissions/* ──────────────────────────────────────────────
    if (resource === 'permissions') {
      if (sub === 'mode') {
        return await handlePermissionMode(req)
      }
      throw ApiError.notFound(`Unknown permissions endpoint: ${sub}`)
    }

    // ── /api/settings/* ─────────────────────────────────────────────────
    const method = req.method

    switch (sub) {
      case undefined:
        // GET /api/settings
        if (method !== 'GET') throw methodNotAllowed(method)
        return Response.json(await settingsService.getSettings())

      case 'user':
        return await handleUserSettings(req)

      case 'project':
        return await handleProjectSettings(req, url)

      case 'proxy':
        return await handleProxySettings(req, segments)

      case 'cli-launcher':
        if (method !== 'GET') throw methodNotAllowed(method)
        return Response.json(await ensureDesktopCliLauncherInstalled())

      default:
        throw ApiError.notFound(`Unknown settings endpoint: ${sub}`)
    }
  } catch (error) {
    return errorResponse(error)
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleUserSettings(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    return Response.json(await settingsService.getUserSettings())
  }

  if (req.method === 'PUT') {
    const body = await parseJsonBody(req)
    await settingsService.updateUserSettings(body)
    return Response.json({ ok: true })
  }

  throw methodNotAllowed(req.method)
}

async function handleProjectSettings(req: Request, url: URL): Promise<Response> {
  const projectRoot = url.searchParams.get('projectRoot') || undefined

  if (req.method === 'GET') {
    return Response.json(await settingsService.getProjectSettings(projectRoot))
  }

  if (req.method === 'PUT') {
    const body = await parseJsonBody(req)
    await settingsService.updateProjectSettings(body, projectRoot)
    return Response.json({ ok: true })
  }

  throw methodNotAllowed(req.method)
}

async function handleProxySettings(req: Request, segments: string[]): Promise<Response> {
  const action = segments[3] // 'test' | undefined

  if (action === 'test') {
    if (req.method !== 'POST') throw methodNotAllowed(req.method)
    const body = await parseJsonBody(req)
    const config = parseProxyConfig(body)
    return Response.json(await proxySettingsService.testConfig(config))
  }

  if (req.method === 'GET') {
    return Response.json(await proxySettingsService.getConfig())
  }

  if (req.method === 'PUT') {
    const body = await parseJsonBody(req)
    const config = parseProxyConfig(body)
    await proxySettingsService.setConfig(config)
    return Response.json({ ok: true })
  }

  throw methodNotAllowed(req.method)
}

function parseProxyConfig(body: Record<string, unknown>): ProxyConfig {
  const portRaw = body.port
  let port: number | null = null
  if (portRaw !== null && portRaw !== undefined && portRaw !== '') {
    const n = typeof portRaw === 'number' ? portRaw : Number(portRaw)
    if (!Number.isFinite(n)) throw ApiError.badRequest('Invalid port')
    port = Math.trunc(n)
  }
  return {
    enabled: body.enabled === true,
    host: typeof body.host === 'string' ? body.host : '',
    port,
    username: typeof body.username === 'string' ? body.username : '',
    password: typeof body.password === 'string' ? body.password : '',
  }
}

async function handlePermissionMode(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    const mode = await settingsService.getPermissionMode()
    return Response.json({ mode })
  }

  if (req.method === 'PUT') {
    const body = await parseJsonBody(req)
    const mode = body.mode
    if (typeof mode !== 'string') {
      throw ApiError.badRequest('Missing or invalid "mode" in request body')
    }
    await settingsService.setPermissionMode(mode)
    return Response.json({ ok: true, mode })
  }

  throw methodNotAllowed(req.method)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}

function methodNotAllowed(method: string): ApiError {
  return new ApiError(405, `Method ${method} not allowed`, 'METHOD_NOT_ALLOWED')
}
