import { describe, expect, test } from 'bun:test'
import {
  resolveCodexExecTimeoutMs,
  shouldUseTaskkill,
} from '../services/conversationService.js'

describe('resolveCodexExecTimeoutMs', () => {
  test('uses five minutes by default', () => {
    expect(resolveCodexExecTimeoutMs(undefined)).toBe(5 * 60_000)
    expect(resolveCodexExecTimeoutMs('')).toBe(5 * 60_000)
  })

  test('accepts a positive millisecond override', () => {
    expect(resolveCodexExecTimeoutMs('12345')).toBe(12_345)
  })

  test('ignores invalid overrides', () => {
    expect(resolveCodexExecTimeoutMs('0')).toBe(5 * 60_000)
    expect(resolveCodexExecTimeoutMs('-1')).toBe(5 * 60_000)
    expect(resolveCodexExecTimeoutMs('abc')).toBe(5 * 60_000)
  })
})

describe('shouldUseTaskkill', () => {
  test('true on win32 with a valid pid', () => {
    expect(shouldUseTaskkill('win32', 1234)).toBe(true)
  })

  test('false on non-win32 even with a valid pid', () => {
    expect(shouldUseTaskkill('linux', 1234)).toBe(false)
    expect(shouldUseTaskkill('darwin', 1234)).toBe(false)
  })

  test('false when pid is missing or non-positive', () => {
    expect(shouldUseTaskkill('win32', undefined)).toBe(false)
    expect(shouldUseTaskkill('win32', 0)).toBe(false)
    expect(shouldUseTaskkill('win32', -1)).toBe(false)
  })
})
