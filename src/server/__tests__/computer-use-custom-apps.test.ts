import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { handleComputerUseApi } from '../api/computer-use.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'cu-custom-app-'))
const exePath = join(tmpRoot, 'CleanMaster.exe')
writeFileSync(exePath, 'MZ')

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

function callResolve(body: unknown): Promise<Response> {
  const url = new URL('http://localhost/api/computer-use/apps/resolve')
  const segments = url.pathname.split('/').filter(Boolean)
  const req = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return handleComputerUseApi(req, url, segments)
}

describe('POST /api/computer-use/apps/resolve', () => {
  test('valid exe path resolves to its stem as bundleId', async () => {
    const res = await callResolve({ path: exePath })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { bundleId: string; displayName: string; path: string }
    expect(json.bundleId).toBe('CleanMaster')
    expect(json.displayName).toBe('CleanMaster')
    expect(json.path).toBe(exePath)
  })

  test('surrounding quotes (Explorer "Copy as path") are stripped', async () => {
    const res = await callResolve({ path: `"${exePath}"` })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { bundleId: string }
    expect(json.bundleId).toBe('CleanMaster')
  })

  test('empty path is rejected', async () => {
    const res = await callResolve({ path: '   ' })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('PATH_REQUIRED')
  })

  test('missing file is rejected with 404', async () => {
    const res = await callResolve({ path: join(tmpRoot, 'does-not-exist.exe') })
    expect(res.status).toBe(404)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('FILE_NOT_FOUND')
  })

  test('non-exe file is rejected on Windows', async () => {
    if (process.platform !== 'win32') return
    const txtPath = join(tmpRoot, 'notes.txt')
    writeFileSync(txtPath, 'hi')
    const res = await callResolve({ path: txtPath })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('NOT_EXECUTABLE')
  })
})

describe('win_helper installed-apps filtering (source contract)', () => {
  test('helper filters junk registry entries and requires a launchable exe', async () => {
    const helper = await Bun.file(new URL('../../../runtime/win_helper.py', import.meta.url)).text()
    expect(helper).toContain('JUNK_NAME_KEYWORDS')
    expect(helper).toContain('def _resolve_app_exe(')
    expect(helper).toContain('def _is_system_entry(')
    // open_app must accept the stored custom path for portable apps
    expect(helper).toContain('def open_app(bundle_id: str, path: str | None = None)')
    expect(helper).toContain('open_app(str(payload["bundleId"]), payload.get("path"))')
  })
})
