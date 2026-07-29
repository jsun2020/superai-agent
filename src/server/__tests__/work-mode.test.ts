import { describe, expect, test } from 'bun:test'
import {
  WORK_MODE_PROMPT,
  buildModeCliArgs,
  isSessionMode,
} from '../services/workMode'

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
