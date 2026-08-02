import { afterAll, describe, expect, test } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  OUTBOUND_ASK_REASON,
  OUTBOUND_TOOL_MATCHER,
  buildOutboundAskPayload,
  buildOutboundHookCommand,
  buildOutboundPolicyArgs,
  buildOutboundPolicySettings,
  matchesOutboundTool,
  writeOutboundPolicy,
} from '../services/outboundPolicy.js'

const tmpDirs: string[] = []
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-policy-'))
  tmpDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

describe('outbound tool matching', () => {
  test('asks on real outbound tool names from both shipped connectors', () => {
    for (const toolName of [
      // Feishu puts the verb last.
      'mcp__lark-mcp__im_v1_message_create',
      'mcp__lark-mcp__im_v1_message_reply',
      'mcp__lark-mcp__calendar_v4_calendar_event_create',
      'mcp__lark-mcp__docx_v1_document_patch',
      'mcp__lark-mcp__drive_v1_file_delete',
      // Microsoft 365 puts the verb first.
      'mcp__ms-365__send-mail',
      'mcp__ms-365__create-event',
      'mcp__ms-365__update-event',
      'mcp__ms-365__delete-event',
    ]) {
      expect(matchesOutboundTool(toolName)).toBe(true)
    }
  })

  test('stays silent on reads, so people do not learn to click through', () => {
    for (const toolName of [
      'mcp__lark-mcp__im_v1_message_list',
      'mcp__lark-mcp__docx_v1_document_get',
      'mcp__lark-mcp__drive_v1_file_list',
      'mcp__ms-365__list-mail',
      'mcp__ms-365__get-event',
      'mcp__ms-365__search-files',
    ]) {
      expect(matchesOutboundTool(toolName)).toBe(false)
    }
  })

  test('keeps its hands off built-in tools', () => {
    // Bash/Edit/Write keep their existing permission handling; prompting on
    // every command would create exactly the fatigue this avoids.
    for (const toolName of ['Bash', 'Edit', 'Write', 'Read', 'WebFetch', 'Agent']) {
      expect(matchesOutboundTool(toolName)).toBe(false)
    }
  })

  test('still matches when a vendor adds a versioned variant', () => {
    // The whole reason for a regex rather than a named allowlist: a named list
    // silently stops covering the moment a vendor ships a new tool name.
    expect(matchesOutboundTool('mcp__ms-365__send-mail-v2')).toBe(true)
    expect(matchesOutboundTool('mcp__lark-mcp__im_v2_message_create')).toBe(true)
    expect(matchesOutboundTool('mcp__some-new-crm__create_deal')).toBe(true)
  })

  test('a verb must be its own segment, not a substring', () => {
    // "increate"/"updated_at" style names should not trip the matcher.
    expect(matchesOutboundTool('mcp__srv__recreated_report')).toBe(false)
    expect(matchesOutboundTool('mcp__srv__moved')).toBe(false)
  })

  test('the matcher is treated as a regex, not a literal, by hooks.ts', () => {
    // matchesPattern() only takes the regex branch when the string contains
    // something outside [a-zA-Z0-9_|]; if this ever became plain it would
    // silently match nothing.
    expect(/^[a-zA-Z0-9_|]+$/.test(OUTBOUND_TOOL_MATCHER)).toBe(false)
  })
})

describe('outbound ask payload', () => {
  test('forces an ask, which is what makes it bypass-immune', () => {
    const payload = buildOutboundAskPayload() as {
      hookSpecificOutput: Record<string, unknown>
    }
    expect(payload.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    // 'ask' becomes forceDecision, so print-mode canUseTool never calls
    // hasPermissionsToUseTool and never reaches the bypassPermissions branch.
    expect(payload.hookSpecificOutput.permissionDecision).toBe('ask')
    expect(payload.hookSpecificOutput.permissionDecisionReason).toBe(OUTBOUND_ASK_REASON)
  })

  test('the reason is ASCII-only (it crosses a Windows shell)', () => {
    expect(OUTBOUND_ASK_REASON).toMatch(/^[\x20-\x7E]*$/)
  })
})

describe('hook command', () => {
  test('uses PowerShell on Windows rather than assuming Git Bash', () => {
    const { command, shell } = buildOutboundHookCommand('C:\\policy\\ask.json', 'win32')
    expect(shell).toBe('powershell')
    expect(command).toBe("Get-Content -Raw -LiteralPath 'C:\\policy\\ask.json'")
  })

  test('uses the default shell elsewhere', () => {
    const { command, shell } = buildOutboundHookCommand('/tmp/policy/ask.json', 'darwin')
    expect(shell).toBeUndefined()
    expect(command).toBe("cat '/tmp/policy/ask.json'")
  })

  test('quotes paths containing spaces and quotes', () => {
    expect(buildOutboundHookCommand("C:\\Users\\O'Brien Smith\\ask.json", 'win32').command)
      .toBe("Get-Content -Raw -LiteralPath 'C:\\Users\\O''Brien Smith\\ask.json'")
    expect(buildOutboundHookCommand("/home/o'brien smith/ask.json", 'linux').command)
      .toBe(`cat '/home/o'\\''brien smith/ask.json'`)
  })
})

describe('policy settings file', () => {
  test('registers a PreToolUse hook on the outbound matcher', () => {
    const settings = buildOutboundPolicySettings('/tmp/ask.json', 'linux') as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<Record<string, unknown>> }> }
    }
    const entry = settings.hooks.PreToolUse[0]!
    expect(entry.matcher).toBe(OUTBOUND_TOOL_MATCHER)
    expect(entry.hooks[0]!.type).toBe('command')
    expect(entry.hooks[0]!.timeout).toBe(10)
  })

  test('validates against the CLI\'s own HooksSchema', async () => {
    // Shape assertions only prove what I wrote. If the real schema rejects
    // this object the settings file loads and the policy silently does
    // nothing — the exact failure mode a safety control must not have.
    const { HooksSchema } = await import('../../schemas/hooks.js')
    const settings = buildOutboundPolicySettings('/tmp/ask.json', 'linux') as {
      hooks: unknown
    }
    const parsed = HooksSchema().safeParse(settings.hooks)
    expect(parsed.success).toBe(true)

    // Control: the schema must actually be capable of rejecting something, or
    // the assertion above is vacuous.
    expect(
      HooksSchema().safeParse({
        PreToolUse: [{ matcher: 'x', hooks: [{ type: 'not-a-real-hook-type' }] }],
      }).success,
    ).toBe(false)
  })

  test('declares nothing but hooks', () => {
    // This file is merged in as a `flagSettings` source. It must never carry a
    // permissions block, which is how it could weaken the user's own rules.
    const settings = buildOutboundPolicySettings('/tmp/ask.json', 'linux')
    expect(Object.keys(settings)).toEqual(['hooks'])
  })
})

describe('policy CLI args', () => {
  test('only Work mode gets the policy', () => {
    const dir = makeTmpDir()
    expect(buildOutboundPolicyArgs('code', dir, 'linux')).toEqual([])
    expect(buildOutboundPolicyArgs(null, dir, 'linux')).toEqual([])
    expect(buildOutboundPolicyArgs(undefined, dir, 'linux')).toEqual([])
    expect(buildOutboundPolicyArgs('assistant', dir, 'linux')).toEqual([])
  })

  test('Work mode passes --settings pointing at a real, parseable file', () => {
    const dir = makeTmpDir()
    const args = buildOutboundPolicyArgs('work', dir, 'linux')
    expect(args[0]).toBe('--settings')

    const settingsPath = args[1]!
    expect(fs.existsSync(settingsPath)).toBe(true)
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    expect(settings.hooks.PreToolUse[0].matcher).toBe(OUTBOUND_TOOL_MATCHER)

    // The referenced payload file must exist and be the ask decision — a
    // settings file pointing at a missing file would fail open, silently.
    const command: string = settings.hooks.PreToolUse[0].hooks[0].command
    const responsePath = command.slice(command.indexOf("'") + 1, command.lastIndexOf("'"))
    expect(fs.existsSync(responsePath)).toBe(true)
    expect(JSON.parse(fs.readFileSync(responsePath, 'utf-8'))).toEqual(
      buildOutboundAskPayload(),
    )
  })

  test('a write failure degrades to no args instead of breaking the session', () => {
    // Point at a path that cannot be a directory.
    const dir = makeTmpDir()
    const filePath = path.join(dir, 'not-a-dir')
    fs.writeFileSync(filePath, 'x', 'utf-8')
    expect(writeOutboundPolicy(path.join(filePath, 'nested'), 'linux')).toBeNull()
    expect(buildOutboundPolicyArgs('work', path.join(filePath, 'nested'), 'linux')).toEqual([])
  })
})
