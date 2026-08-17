import { describe, expect, test } from 'bun:test'
import {
  ROLE_PROMPTS,
  WORK_MODE_PROMPT,
  buildModeCliArgs,
  isSessionMode,
  isSessionRole,
  listSessionRoles,
} from '../services/workMode'
import { useTempSuperaiHome } from './fixtures/tempSuperaiHome'

// Every test here runs against a fresh, freshly-seeded ~/.superai, so the
// prompts under test are the shipped ones, not whatever this machine's owner
// last edited.
useTempSuperaiHome()

/** The three roles this product ships with; the seeds must reproduce them. */
const SESSION_ROLES = ['assistant', 'sales', 'analyst'] as const

describe('work mode', () => {
  test('buildModeCliArgs appends the work-mode system prompt only for work sessions', () => {
    expect(buildModeCliArgs('work')).toEqual([
      '--append-system-prompt',
      WORK_MODE_PROMPT,
    ])
    expect(buildModeCliArgs('code')).toEqual([])
    expect(buildModeCliArgs(null)).toEqual([])
    expect(buildModeCliArgs(undefined)).toEqual([])
  })

  test('work-mode prompt steers office tasks to the office subagent', () => {
    expect(WORK_MODE_PROMPT).toContain("'office'")
    expect(WORK_MODE_PROMPT).toContain('Agent tool')
    for (const marker of ['.pptx', '.xlsx', '.docx', 'PDF']) {
      expect(WORK_MODE_PROMPT).toContain(marker)
    }
  })

  test('work-mode prompt sets a non-developer, non-destructive tone', () => {
    expect(WORK_MODE_PROMPT).toContain('plain language')
    expect(WORK_MODE_PROMPT).toContain('new file')
    expect(WORK_MODE_PROMPT).toContain('absolute path')
  })

  test('work-mode prompt is ASCII-only so it survives Windows arg passing', () => {
    expect(/^[\x20-\x7E\n]*$/.test(WORK_MODE_PROMPT)).toBe(true)
  })

  test('isSessionMode accepts only work and code', () => {
    expect(isSessionMode('work')).toBe(true)
    expect(isSessionMode('code')).toBe(true)
    expect(isSessionMode('office')).toBe(false)
    expect(isSessionMode('')).toBe(false)
    expect(isSessionMode(undefined)).toBe(false)
    expect(isSessionMode(42)).toBe(false)
  })
})

describe('workplace roles', () => {
  test('the seeded folder offers exactly the three shipped roles', () => {
    expect(listSessionRoles()).toEqual([...SESSION_ROLES])
    // 'office' is deliberately NOT a role — no role at all is the document
    // experience that WORK_MODE_PROMPT already describes.
    expect(listSessionRoles()).not.toContain('office')
  })

  test('isSessionRole is a shape check on the id, not an existence check', () => {
    // Existence is loadWorkRoles()' job; a session stamped with a role whose
    // file was later deleted must still be readable.
    for (const role of SESSION_ROLES) expect(isSessionRole(role)).toBe(true)
    expect(isSessionRole('recruiter')).toBe(true)
    expect(isSessionRole('')).toBe(false)
    expect(isSessionRole('Not Valid')).toBe(false)
    expect(isSessionRole('../escape')).toBe(false)
    expect(isSessionRole(undefined)).toBe(false)
    expect(isSessionRole(42)).toBe(false)
  })

  test('a role appends its framing after the base work-mode prompt', () => {
    for (const role of SESSION_ROLES) {
      const args = buildModeCliArgs('work', role)
      expect(args[0]).toBe('--append-system-prompt')
      expect(args).toHaveLength(2)
      // One flag carrying one concatenated prompt — passing the flag twice is
      // not guaranteed to be additive on the CLI side.
      expect(args[1]).toBe(`${WORK_MODE_PROMPT}\n\n${ROLE_PROMPTS[role]!}`)
    }
  })

  test('work mode without a role is byte-identical to before roles existed', () => {
    const bare = ['--append-system-prompt', WORK_MODE_PROMPT]
    expect(buildModeCliArgs('work')).toEqual(bare)
    expect(buildModeCliArgs('work', null)).toEqual(bare)
    expect(buildModeCliArgs('work', undefined)).toEqual(bare)
    // An unrecognised stamp must degrade to plain Work mode, never throw.
    expect(buildModeCliArgs('work', 'marketing')).toEqual(bare)
  })

  test('a role outside work mode changes nothing', () => {
    // Code mode must stay byte-identical even if a role is somehow stamped.
    for (const role of SESSION_ROLES) {
      expect(buildModeCliArgs('code', role)).toEqual([])
      expect(buildModeCliArgs(null, role)).toEqual([])
      expect(buildModeCliArgs(undefined, role)).toEqual([])
    }
  })

  test('every role points at its own subagent and restates its key guard', () => {
    expect(ROLE_PROMPTS.assistant!).toContain("'assistant' subagent")
    expect(ROLE_PROMPTS.assistant!).toContain('Draft, never send')
    expect(ROLE_PROMPTS.sales!).toContain("'sales' subagent")
    expect(ROLE_PROMPTS.sales!).toContain('Never invent a price')
    expect(ROLE_PROMPTS.analyst!).toContain("'analyst' subagent")
    expect(ROLE_PROMPTS.analyst!).toContain('never write over')
  })

  test('role prompts are ASCII-only so they survive Windows arg passing', () => {
    for (const role of SESSION_ROLES) {
      expect(/^[\x20-\x7E\n]*$/.test(ROLE_PROMPTS[role]!)).toBe(true)
    }
  })
})
