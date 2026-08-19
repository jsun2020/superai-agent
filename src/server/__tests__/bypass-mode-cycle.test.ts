/**
 * "bypass permissions on" is part of the TUI's Shift+Tab cycle by default.
 */
import { describe, expect, test } from 'bun:test'
import type { ToolPermissionContext } from '../../Tool.js'
import { isBypassModeOfferedByDefault } from '../../utils/permissions/bypassModeAvailability.js'
import { getNextPermissionMode } from '../../utils/permissions/getNextPermissionMode.js'

describe('isBypassModeOfferedByDefault', () => {
  test('on by default', () => {
    expect(isBypassModeOfferedByDefault({}, 'win32', undefined)).toBe(true)
    expect(isBypassModeOfferedByDefault({}, 'linux', 1000)).toBe(true)
    expect(isBypassModeOfferedByDefault({}, 'darwin', 501)).toBe(true)
  })
  test('SUPERAI_BYPASS_IN_CYCLE=0 opts out, =1 forces on', () => {
    expect(isBypassModeOfferedByDefault({ SUPERAI_BYPASS_IN_CYCLE: '0' }, 'win32', undefined)).toBe(false)
    expect(isBypassModeOfferedByDefault({ SUPERAI_BYPASS_IN_CYCLE: 'false' }, 'win32', undefined)).toBe(false)
    expect(isBypassModeOfferedByDefault({ SUPERAI_BYPASS_IN_CYCLE: '1' }, 'linux', 0)).toBe(true)
  })
  test('never offered to root on Unix outside a sandbox', () => {
    expect(isBypassModeOfferedByDefault({}, 'linux', 0)).toBe(false)
    expect(isBypassModeOfferedByDefault({ IS_SANDBOX: '1' }, 'linux', 0)).toBe(true)
  })
})

function ctx(mode: ToolPermissionContext['mode'], available: boolean): ToolPermissionContext {
  return {
    mode,
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: available,
  } as unknown as ToolPermissionContext
}

describe('Shift+Tab cycle with bypass available', () => {
  test('default -> acceptEdits -> plan -> bypassPermissions -> default', () => {
    expect(getNextPermissionMode(ctx('default', true))).toBe('acceptEdits')
    expect(getNextPermissionMode(ctx('acceptEdits', true))).toBe('plan')
    expect(getNextPermissionMode(ctx('plan', true))).toBe('bypassPermissions')
    expect(getNextPermissionMode(ctx('bypassPermissions', true))).toBe('default')
  })
  test('skips bypass when it is not available (declined / disabled in settings)', () => {
    expect(getNextPermissionMode(ctx('plan', false))).toBe('default')
  })
})
