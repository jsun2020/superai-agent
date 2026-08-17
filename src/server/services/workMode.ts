/**
 * Work/Code session modes.
 *
 * "Work" targets general (non-programmer) office users; "Code" is the
 * existing developer experience and adds nothing. The mode is chosen in the
 * desktop UI, stamped on the session's session-meta JSONL entry at creation,
 * and applied at spawn time as an --append-system-prompt steer, so the base
 * coding system prompt and all tooling stay intact.
 */

import { findWorkRole, isValidRoleId, loadWorkModePrompt, loadWorkRoles } from './workRoles.js'
import { BUILT_IN_ROLES, BUILT_IN_WORK_MODE_PROMPT } from './workplaceDefaults.js'

export type SessionMode = 'work' | 'code'

export function isSessionMode(value: unknown): value is SessionMode {
  return value === 'work' || value === 'code'
}

/**
 * Optional workplace role within Work mode, picked from the cards on the new
 * session screen. Roles are files in ~/.superai/roles (see workRoles.ts); the
 * three built-ins are seeded there on first run. There is deliberately no
 * 'office' role: no role at all IS the document experience that the base
 * Work-mode prompt already describes.
 *
 * A SessionRole is any well-formed role id. Whether it currently EXISTS is a
 * separate question (findWorkRole): a session stamped with a role whose file
 * was later deleted keeps its stamp and simply runs as plain Work mode.
 */
export type SessionRole = string

export function isSessionRole(value: unknown): value is SessionRole {
  return isValidRoleId(value)
}

/** Ids of the roles currently available, built-in and user-defined. */
export function listSessionRoles(): SessionRole[] {
  return loadWorkRoles().map((role) => role.id)
}

/**
 * The shipped base prompt. Exported for tests and as the documented default;
 * at runtime buildModeCliArgs reads ~/.superai/work-mode.md, which starts as
 * a copy of this. ASCII-only: passed as a CLI argument on Windows.
 */
export const WORK_MODE_PROMPT = BUILT_IN_WORK_MODE_PROMPT

/**
 * The shipped role prompts, keyed by id. Same status as WORK_MODE_PROMPT:
 * the documented defaults, and what ~/.superai/roles/<id>.md starts as.
 */
export const ROLE_PROMPTS: Record<string, string> = Object.fromEntries(
  BUILT_IN_ROLES.map((role) => [role.id, role.prompt]),
)

/**
 * Extra CLI args for a session's mode and role. Only 'work' adds anything;
 * 'code', null (legacy sessions with no stamp), and undefined are the status
 * quo. A role outside Work mode is ignored by design, so a stray stamp can
 * never change the Code experience. An unknown or deleted role degrades to
 * plain Work mode rather than failing the spawn.
 */
export function buildModeCliArgs(
  mode: string | null | undefined,
  role?: string | null | undefined,
): string[] {
  if (mode !== 'work') return []

  const base = loadWorkModePrompt()
  const found = findWorkRole(role)
  const prompt = found ? `${base}

${found.prompt}` : base

  return ['--append-system-prompt', prompt]
}
