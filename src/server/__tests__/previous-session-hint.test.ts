/**
 * The "last session" hint shown in the TUI's condensed startup header —
 * tells a terminal user that `superai -c` / `/resume` exist without them
 * having to know Claude Code's CLI flags.
 */
import { describe, expect, test } from 'bun:test'
import {
  buildPreviousSessionHint,
  markResumedAtLaunch,
  wasResumedAtLaunch,
} from '../../utils/previousSessionHint.js'

const NOW = new Date('2026-08-18T12:00:00Z')

function activity(overrides: Partial<{ summary: string; firstPrompt: string; modified: Date }> = {}) {
  return {
    summary: overrides.summary,
    firstPrompt: overrides.firstPrompt ?? 'fix the provider setup flow',
    modified: overrides.modified ?? new Date('2026-08-18T10:00:00Z'),
  }
}

describe('buildPreviousSessionHint', () => {
  test('returns null when there is no earlier session in this folder', () => {
    expect(buildPreviousSessionHint([], { width: 100, now: NOW })).toBeNull()
  })

  test('names the last session with its age and how to continue or pick one', () => {
    const hint = buildPreviousSessionHint([activity()], { width: 120, now: NOW })
    expect(hint).toBe(
      'Last session 2h ago: fix the provider setup flow · superai -c continues it · /resume picks another',
    )
  })

  test('prefers the summary over the first prompt when the session has one', () => {
    const hint = buildPreviousSessionHint(
      [activity({ summary: 'Provider setup for the terminal', firstPrompt: 'hello' })],
      { width: 120, now: NOW },
    )
    expect(hint).toContain('Last session 2h ago: Provider setup for the terminal')
  })

  test('truncates the description so the whole hint fits the header width', () => {
    const hint = buildPreviousSessionHint(
      [activity({ firstPrompt: 'a'.repeat(200) })],
      { width: 90, now: NOW },
    )
    expect(hint).not.toBeNull()
    expect(hint!.length).toBeLessThanOrEqual(90)
    expect(hint).toMatch(/aaa…? · superai -c continues it · \/resume picks another$/)
  })

  test('drops the description entirely when the header is too narrow for it', () => {
    const hint = buildPreviousSessionHint([activity()], { width: 70, now: NOW })
    expect(hint).toBe('superai -c continues the last session · /resume picks another')
  })

  test('returns null when even the short form does not fit', () => {
    expect(buildPreviousSessionHint([activity()], { width: 30, now: NOW })).toBeNull()
  })

  test('uses the first prompt when the summary is the "No prompt" placeholder', () => {
    const hint = buildPreviousSessionHint(
      [activity({ summary: 'No prompt', firstPrompt: 'write the release notes' })],
      { width: 120, now: NOW },
    )
    expect(hint).toContain(': write the release notes ·')
  })

  test('collapses newlines and runs of whitespace in the description', () => {
    const hint = buildPreviousSessionHint(
      [activity({ firstPrompt: 'line one\n\n   line   two' })],
      { width: 120, now: NOW },
    )
    expect(hint).toContain(': line one line two ·')
  })
})

describe('wasResumedAtLaunch', () => {
  test('is false until a CLI resume marks it', () => {
    expect(wasResumedAtLaunch()).toBe(false)
    markResumedAtLaunch()
    expect(wasResumedAtLaunch()).toBe(true)
  })
})
