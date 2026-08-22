/**
 * Debug logging is the only way to diagnose a failure on a machine we cannot
 * reach, and a desktop user's ONLY way to turn it on is a DEBUG entry in
 * settings.json - the GUI spawns the sidecar, so --debug is not available to
 * them. The memoized getters are evaluated before settings.env is applied, so
 * without an explicit refresh that setting is silently ignored.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  isDebugMode,
  refreshDebugSettingsFromEnv,
} from '../debug.js'

const SNAPSHOT = process.env.DEBUG

afterEach(() => {
  // process.env is process-wide and shared across vitest/bun workers (LL-041),
  // so a test that mutates it must put it back.
  if (SNAPSHOT === undefined) delete process.env.DEBUG
  else process.env.DEBUG = SNAPSHOT
  refreshDebugSettingsFromEnv()
})

describe('refreshDebugSettingsFromEnv', () => {
  test('a DEBUG applied after the first read is honoured only after a refresh', () => {
    delete process.env.DEBUG
    refreshDebugSettingsFromEnv()
    // First read locks the memo, exactly as startup does before
    // applySafeConfigEnvironmentVariables() runs.
    expect(isDebugMode()).toBe(false)

    // settings.json env lands in process.env at this point...
    process.env.DEBUG = '1'
    // ...and is invisible, because the value is memoized. This assertion is the
    // bug itself, pinned so it cannot silently return.
    expect(isDebugMode()).toBe(false)

    refreshDebugSettingsFromEnv()
    expect(isDebugMode()).toBe(true)
  })

  test('the refresh does not fabricate debug mode when nothing set it', () => {
    // Control: if refreshing alone flipped the flag, the test above would pass
    // for the wrong reason.
    delete process.env.DEBUG
    refreshDebugSettingsFromEnv()
    expect(isDebugMode()).toBe(false)
    refreshDebugSettingsFromEnv()
    expect(isDebugMode()).toBe(false)
  })
})
