/**
 * Connector catalog, loaded from ~/.superai/connectors/<id>.json and merged
 * over the built-ins, plus the renderer that turns a connector's declarative
 * config template + the user's form values into a real MCP server config.
 *
 * Why the renderer is here and not in the desktop: the template format is a
 * contract users write files against. Keeping the format, its documentation
 * (README in superaiHome.ts), the shipped defaults and the tests in one
 * process means a template that renders in a test renders identically for a
 * user — there is no second implementation to drift.
 *
 * Merge rules mirror workRoles.ts: filename is the id, same-id files
 * shallow-override built-ins, `disabled: true` hides, invalid files are
 * skipped loudly and never remove a built-in.
 */

import * as fs from 'fs'
import * as path from 'path'

import { isLocalizedText } from './localized.js'
import { ensureSuperaiHomeOnce, getConnectorsDir, readUserTextFile } from './superaiHome.js'
import {
  BUILT_IN_CONNECTORS,
  type ArgTemplate,
  type ConnectorConfigTemplate,
  type ConnectorDefinition,
  type ConnectorFieldDefinition,
} from './workplaceDefaults.js'

export type Connector = ConnectorDefinition & {
  source: 'built-in' | 'file'
  path?: string
}

export const CONNECTOR_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

export function loadConnectors(): Connector[] {
  ensureSuperaiHomeOnce()

  const byId = new Map<string, Connector>()
  for (const connector of BUILT_IN_CONNECTORS) {
    byId.set(connector.id, { ...connector, source: 'built-in' })
  }

  const dir = getConnectorsDir()
  let entries: string[] = []
  try {
    entries = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
  } catch {
    // Built-ins only.
  }

  for (const entry of entries) {
    const id = entry.slice(0, -'.json'.length)
    const filePath = path.join(dir, entry)
    if (!CONNECTOR_ID_PATTERN.test(id)) {
      console.error(
        `[WorkConnectors] Ignoring ${filePath}: the filename must be lowercase letters, digits and dashes.`,
      )
      continue
    }
    let raw: unknown
    try {
      raw = JSON.parse(readUserTextFile(filePath))
    } catch (error) {
      console.error(`[WorkConnectors] Ignoring ${filePath}: not valid JSON.`, error)
      continue
    }
    const base = byId.get(id)
    const merged = { ...(base ?? {}), ...(raw as object), id }
    const problem = validateConnector(merged)
    if (problem) {
      console.error(`[WorkConnectors] Ignoring ${filePath}: ${problem}`)
      continue
    }
    byId.set(id, { ...(merged as ConnectorDefinition), source: 'file', path: filePath })
  }

  return [...byId.values()].filter((connector) => !connector.disabled)
}

export function findConnector(id: unknown): Connector | undefined {
  if (typeof id !== 'string' || !CONNECTOR_ID_PATTERN.test(id)) return undefined
  return loadConnectors().find((connector) => connector.id === id)
}

/**
 * Shape check for a (merged) connector. Returns a human-readable reason or
 * null. Deliberately strict about the parts that would otherwise fail at
 * connect time with an unhelpful error.
 */
export function validateConnector(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'expected a JSON object'
  }
  const c = value as Record<string, unknown>
  if (typeof c.serverName !== 'string' || !c.serverName.trim()) {
    return '"serverName" must be a non-empty string'
  }
  if (typeof c.icon !== 'string') return '"icon" must be a string'
  for (const key of ['name', 'description', 'worksWith'] as const) {
    if (!isLocalizedText(c[key])) {
      return `"${key}" must be a string or an object of locale -> string`
    }
  }
  if (c.provenance !== 'official' && c.provenance !== 'community') {
    return '"provenance" must be "official" or "community"'
  }
  if (c.status !== 'available' && c.status !== 'coming-soon') {
    return '"status" must be "available" or "coming-soon"'
  }
  if (!Array.isArray(c.fields)) return '"fields" must be an array'
  for (const [i, field] of c.fields.entries()) {
    const problem = validateField(field)
    if (problem) return `fields[${i}]: ${problem}`
  }
  if (c.status === 'available') {
    const problem = validateConfigTemplate(c.config)
    if (problem) return `config: ${problem}`
  }
  return null
}

function validateField(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'expected an object'
  const f = value as Record<string, unknown>
  if (typeof f.key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.key)) {
    return '"key" must be an identifier (letters, digits, underscore)'
  }
  if (!isLocalizedText(f.label)) return '"label" is required'
  switch (f.type) {
    case 'text':
    case 'password':
      return null
    case 'select':
      if (typeof f.defaultValue !== 'string') return 'select needs a string "defaultValue"'
      if (!Array.isArray(f.options) || f.options.length === 0) {
        return 'select needs a non-empty "options" array'
      }
      for (const opt of f.options) {
        const o = opt as Record<string, unknown>
        if (!o || typeof o.value !== 'string' || !isLocalizedText(o.label)) {
          return 'each select option needs a string "value" and a "label"'
        }
      }
      return null
    case 'checkbox':
      if (typeof f.defaultValue !== 'boolean') return 'checkbox needs a boolean "defaultValue"'
      return null
    default:
      return '"type" must be text, password, select or checkbox'
  }
}

function validateConfigTemplate(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return 'an "available" connector needs a "config" template'
  }
  const t = value as Record<string, unknown>
  if (t.type === 'stdio') {
    if (typeof t.command !== 'string' || !t.command.trim()) return '"command" is required'
    if (!Array.isArray(t.args)) return '"args" must be an array'
    for (const [i, arg] of t.args.entries()) {
      if (typeof arg === 'string') continue
      const a = arg as Record<string, unknown>
      const cond = typeof a?.if === 'string' ? a.if : typeof a?.unless === 'string' ? a.unless : null
      if (!cond || !Array.isArray(a.then) || !a.then.every((s) => typeof s === 'string')) {
        return `args[${i}] must be a string or { "if"|"unless": "<field key>", "then": [strings] }`
      }
    }
    if (t.env !== undefined && !isStringRecord(t.env)) return '"env" must map strings to strings'
    return null
  }
  if (t.type === 'http' || t.type === 'sse') {
    if (typeof t.url !== 'string' || !t.url.trim()) return '"url" is required'
    if (t.headers !== undefined && !isStringRecord(t.headers)) {
      return '"headers" must map strings to strings'
    }
    return null
  }
  return '"type" must be stdio, http or sse'
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value as object).every((v) => typeof v === 'string')
  )
}

// ─── Rendering ──────────────────────────────────────────────────────────────

export type ConnectorFieldValue = string | boolean
export type ConnectorFormValues = Record<string, ConnectorFieldValue>

export type RenderedMcpConfig =
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }

/** "Set" for a conditional: a checked box or a non-blank string. */
function isSet(value: ConnectorFieldValue | undefined): boolean {
  if (typeof value === 'boolean') return value
  return typeof value === 'string' && value.trim().length > 0
}

function substitute(template: string, values: ConnectorFormValues): string {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, key: string) => {
    const value = values[key]
    if (typeof value === 'string') return value.trim()
    if (typeof value === 'boolean') return value ? 'true' : ''
    return ''
  })
}

function renderArgs(args: ArgTemplate[], values: ConnectorFormValues): string[] {
  const out: string[] = []
  for (const arg of args) {
    if (typeof arg === 'string') {
      out.push(substitute(arg, values))
    } else if ('if' in arg) {
      if (isSet(values[arg.if])) out.push(...arg.then.map((s) => substitute(s, values)))
    } else if (!isSet(values[arg.unless])) {
      out.push(...arg.then.map((s) => substitute(s, values)))
    }
  }
  return out
}

/**
 * Turn a template + form values into the exact object mcpStore.createServer
 * expects. Missing values substitute as empty strings rather than throwing:
 * the form already blocks submit on empty required fields, and an optional
 * blank must simply not appear.
 */
export function renderConnectorConfig(
  template: ConnectorConfigTemplate,
  values: ConnectorFormValues,
): RenderedMcpConfig {
  if (template.type === 'stdio') {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(template.env ?? {})) env[k] = substitute(v, values)
    return {
      type: 'stdio',
      command: substitute(template.command, values),
      args: renderArgs(template.args, values),
      env,
    }
  }
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(template.headers ?? {})) headers[k] = substitute(v, values)
  return {
    type: template.type,
    url: substitute(template.url, values),
    ...(Object.keys(headers).length ? { headers } : {}),
  }
}

/** Initial form state for a connector, from each field's declared default. */
export function initialConnectorValues(
  fields: readonly ConnectorFieldDefinition[],
): ConnectorFormValues {
  const values: ConnectorFormValues = {}
  for (const field of fields) {
    if (field.type === 'checkbox') values[field.key] = field.defaultValue
    else if (field.type === 'select') values[field.key] = field.defaultValue
    else values[field.key] = ''
  }
  return values
}
