/**
 * Workplace roles, loaded from ~/.superai/roles/<id>.md and merged over the
 * built-ins.
 *
 * Merge rules (the README documents these; keep them in sync):
 *   - The filename is the id.
 *   - A file whose id matches a built-in shallow-overrides it, so a file that
 *     contains only a prompt body replaces just the prompt.
 *   - Any other file adds a role, after the built-ins, in filename order.
 *   - `disabled: true` removes the role from the list; a role file that fails
 *     to parse is skipped with an error naming the file, and the built-in (if
 *     any) stays. Nothing silently disappears.
 *
 * Read from disk on every call: the list is tiny, and "edit the file, open a
 * new session" must work without a restart.
 */

import * as fs from 'fs'
import * as path from 'path'

import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import type { LocalizedText } from './localized.js'
import {
  ensureSuperaiHomeOnce,
  getRolesDir,
  getWorkModePromptPath,
  normalizeUserText,
  readUserTextFile,
} from './superaiHome.js'
import {
  BUILT_IN_ROLES,
  BUILT_IN_WORK_MODE_PROMPT,
  type WorkRoleDefinition,
} from './workplaceDefaults.js'

export type WorkRole = WorkRoleDefinition & {
  source: 'built-in' | 'file'
  /** Absolute path of the file that defines (or overrides) this role. */
  path?: string
}

export const ROLE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isValidRoleId(value: unknown): value is string {
  return typeof value === 'string' && ROLE_ID_PATTERN.test(value)
}

/**
 * The base Work-mode prompt: ~/.superai/work-mode.md if present and
 * non-empty, else the built-in.
 */
export function loadWorkModePrompt(): string {
  ensureSuperaiHomeOnce()
  try {
    const text = readUserTextFile(getWorkModePromptPath())
    // Allow (and strip) frontmatter so the file can carry a comment header.
    const { content } = parseFrontmatter(text, getWorkModePromptPath())
    const body = content.trim()
    if (body.length > 0) return body
  } catch {
    // Missing or unreadable: the built-in is the contract.
  }
  return BUILT_IN_WORK_MODE_PROMPT
}

export function loadWorkRoles(): WorkRole[] {
  ensureSuperaiHomeOnce()

  const byId = new Map<string, WorkRole>()
  for (const role of BUILT_IN_ROLES) {
    byId.set(role.id, { ...role, source: 'built-in' })
  }

  const dir = getRolesDir()
  let entries: string[] = []
  try {
    entries = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .sort()
  } catch {
    // No folder (unwritable home): built-ins only.
  }

  for (const entry of entries) {
    const id = entry.slice(0, -'.md'.length)
    const filePath = path.join(dir, entry)
    if (!isValidRoleId(id)) {
      console.error(
        `[WorkRoles] Ignoring ${filePath}: the filename must be lowercase letters, digits and dashes.`,
      )
      continue
    }
    const parsed = parseRoleFile(filePath, id)
    if (!parsed) continue
    const base = byId.get(id)
    byId.set(id, {
      ...(base ?? {}),
      ...parsed,
      id,
      source: 'file',
      path: filePath,
    } as WorkRole)
  }

  return [...byId.values()].filter((role) => !role.disabled)
}

export function findWorkRole(id: unknown): WorkRole | undefined {
  if (!isValidRoleId(id)) return undefined
  return loadWorkRoles().find((role) => role.id === id)
}

/**
 * Parse one role file into a PARTIAL definition: only the fields present in
 * the file, so the caller can shallow-merge over a built-in. Returns null (and
 * logs) when the file cannot be used at all.
 */
export function parseRoleFile(
  filePath: string,
  id: string,
): Partial<WorkRoleDefinition> | null {
  let text: string
  try {
    text = readUserTextFile(filePath)
  } catch (error) {
    console.error(`[WorkRoles] Cannot read ${filePath}:`, error)
    return null
  }
  return parseRoleSource(text, filePath, id)
}

/** Pure form of parseRoleFile, for tests and for the seed round-trip check. */
export function parseRoleSource(
  text: string,
  filePath: string,
  id: string,
): Partial<WorkRoleDefinition> | null {
  // Callers normally go through readUserTextFile; normalise again here so the
  // pure function is safe on raw editor output too (BOM, CRLF).
  const normalized = normalizeUserText(text)
  const { frontmatter, content } = parseFrontmatter(normalized, filePath)
  const fm = frontmatter as Record<string, unknown>
  const role: Partial<WorkRoleDefinition> = {}

  const prompt = content.trim()
  if (prompt.length > 0) role.prompt = prompt

  const name = readLocalized(fm, 'name')
  if (name) role.name = name
  const tagline = readLocalized(fm, 'tagline')
  if (tagline) role.tagline = tagline
  const worksWith = readLocalized(fm, 'worksWith')
  if (worksWith) role.worksWith = worksWith
  if (typeof fm.icon === 'string' && fm.icon.trim()) role.icon = fm.icon.trim()

  const examples = readLocalizedList(fm, 'examples')
  if (examples) role.examples = examples

  if (fm.disabled === true || fm.disabled === 'true') role.disabled = true

  // A file that adds a NEW role must at least name it and give it a prompt;
  // an override file may be as small as one line.
  const isBuiltIn = BUILT_IN_ROLES.some((r) => r.id === id)
  if (!isBuiltIn && (!role.name || !role.prompt)) {
    console.error(
      `[WorkRoles] Ignoring ${filePath}: a new role needs a "name" in the frontmatter and a prompt body.`,
    )
    return null
  }
  if (Object.keys(role).length === 0) {
    console.error(`[WorkRoles] Ignoring ${filePath}: the file is empty.`)
    return null
  }
  return role
}

/** `key` -> en, `key_<locale>` -> that locale. */
function readLocalized(fm: Record<string, unknown>, key: string): LocalizedText | undefined {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(fm)) {
    if (typeof v !== 'string' || v.trim() === '') continue
    if (k === key) out.en = v.trim()
    else if (k.startsWith(`${key}_`)) out[k.slice(key.length + 1)] = v.trim()
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * `examples` (en) and `examples_<locale>` lists, zipped by index into one
 * LocalizedText per example. Uneven lists degrade gracefully: the English
 * fallback covers a missing translation.
 */
function readLocalizedList(
  fm: Record<string, unknown>,
  key: string,
): LocalizedText[] | undefined {
  const lists = new Map<string, string[]>()
  for (const [k, v] of Object.entries(fm)) {
    if (!Array.isArray(v)) continue
    const strings = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    if (strings.length === 0) continue
    if (k === key) lists.set('en', strings)
    else if (k.startsWith(`${key}_`)) lists.set(k.slice(key.length + 1), strings)
  }
  if (lists.size === 0) return undefined
  const length = Math.max(...[...lists.values()].map((l) => l.length))
  const out: LocalizedText[] = []
  for (let i = 0; i < length; i++) {
    const item: Record<string, string> = {}
    for (const [locale, list] of lists) {
      const value = list[i]
      if (value !== undefined) item[locale] = value
    }
    out.push(item)
  }
  return out
}
