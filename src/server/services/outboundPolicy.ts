/**
 * Work-mode outbound approval policy.
 *
 * The product promise is "it checks in before anything is sent". This enforces
 * it in the permission path rather than only in the prompt.
 *
 * How it works, and why this shape:
 *
 * - A PreToolUse hook returning permissionDecision 'ask' becomes `forceDecision`
 *   in toolHooks.resolvePreToolUseDecision, and the print-mode canUseTool does
 *   `forceDecision ?? hasPermissionsToUseTool(...)` — so the whole permission
 *   pipeline, INCLUDING the bypassPermissions short-circuit, is skipped and the
 *   user is asked. That makes this strictly additive: it can only ever ADD an
 *   approval, never skip one, even under --dangerously-skip-permissions.
 *
 * - Settings `permissions.ask` rules would also be bypass-immune, but
 *   toolMatchesRule only supports exact `mcp__server__tool` or server-wide
 *   `mcp__server__*` — no substring matching. A named list silently stops
 *   covering when a vendor renames or adds a tool, and server-wide asking
 *   prompts on reads too, which trains people to click through. A hook matcher
 *   is a real regex, so it keeps working when `send_mail_v2` appears.
 *
 * - The matcher runs BEFORE the hook is spawned ("Avoids spawning hooks for
 *   non-matching commands" — schemas/hooks.ts), so reads never pay a process.
 *   Only outbound calls spawn, and those are about to block on a human anyway.
 *
 * - The hook command just prints a constant JSON file. Emitting JSON inline
 *   through a Windows shell is a quoting minefield, so the payload lives in a
 *   file and the command is `Get-Content -Raw` / `cat`.
 *
 * Scope, stated honestly: this covers MCP connector tools, which is where
 * outbound actions live. It deliberately does NOT cover Bash — the agent could
 * still curl something — because prompting on every command in Work mode would
 * produce exactly the click-through fatigue this is meant to avoid. Bash keeps
 * its existing permission handling.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * Tool names that mean "this changes something outside the user's machine".
 *
 * Matched as a segment so a read like `im_v1_message_list` or
 * `docx_v1_document_get` does not trip it, while both vendor naming styles do:
 * Feishu puts the verb last (`im_v1_message_create`), Microsoft 365 puts it
 * first (`send-mail`).
 *
 * Biased toward over-matching on purpose: a needless prompt is an annoyance,
 * a missed one sends mail on the user's behalf.
 */
export const OUTBOUND_VERBS = [
  'create',
  'send',
  'post',
  'update',
  'patch',
  'delete',
  'remove',
  'reply',
  'forward',
  'invite',
  'publish',
  'move',
  'archive',
  'write',
  'share',
  'upload',
] as const

export const OUTBOUND_TOOL_MATCHER = `^mcp__.+__(.+[_-])?(${OUTBOUND_VERBS.join('|')})([_-].+)?$`

// ASCII-only: this travels through settings JSON and a Windows shell.
export const OUTBOUND_ASK_REASON =
  'Work mode checks in before anything leaves your account. Review the details, then approve or reject.'

export function matchesOutboundTool(toolName: string): boolean {
  return new RegExp(OUTBOUND_TOOL_MATCHER).test(toolName)
}

export function buildOutboundAskPayload(): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: OUTBOUND_ASK_REASON,
    },
  }
}

/** Quote a path for the shell that will run the hook command. */
function quoteForShell(filePath: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    // PowerShell single-quoted string: '' escapes an embedded quote.
    return `'${filePath.replace(/'/g, "''")}'`
  }
  return `'${filePath.replace(/'/g, `'\\''`)}'`
}

export function buildOutboundHookCommand(
  responsePath: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; shell?: 'powershell' } {
  if (platform === 'win32') {
    // Explicit powershell: the default hook shell is Git Bash, which a
    // portable-install user very likely does not have.
    return {
      command: `Get-Content -Raw -LiteralPath ${quoteForShell(responsePath, platform)}`,
      shell: 'powershell',
    }
  }
  return { command: `cat ${quoteForShell(responsePath, platform)}` }
}

export function buildOutboundPolicySettings(
  responsePath: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, unknown> {
  const { command, shell } = buildOutboundHookCommand(responsePath, platform)
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: OUTBOUND_TOOL_MATCHER,
          hooks: [
            {
              type: 'command',
              command,
              ...(shell ? { shell } : {}),
              timeout: 10,
              statusMessage: 'Checking outbound action',
            },
          ],
        },
      ],
    },
  }
}

function getPolicyDir(): string {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, 'work-mode-policy')
}

/**
 * Write the policy files and return the settings path, or null if they could
 * not be written.
 *
 * Rewritten every time rather than reused: the payload and matcher change with
 * the app version, and a stale file would silently enforce an old policy.
 */
export function writeOutboundPolicy(
  dir: string = getPolicyDir(),
  platform: NodeJS.Platform = process.platform,
): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const responsePath = path.join(dir, 'outbound-ask.json')
    const settingsPath = path.join(dir, 'settings.json')
    fs.writeFileSync(
      responsePath,
      JSON.stringify(buildOutboundAskPayload()),
      'utf-8',
    )
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(buildOutboundPolicySettings(responsePath, platform), null, 2),
      'utf-8',
    )
    return settingsPath
  } catch (error) {
    // Never block a session on this. The role prompts still instruct the agent
    // to check in, so the user is not left with nothing — but this is a real
    // reduction in enforcement, so it is logged at error level rather than
    // swallowed.
    console.error(
      '[OutboundPolicy] Could not write the Work-mode outbound approval policy; ' +
        'outbound actions will not be force-prompted this session:',
      error,
    )
    return null
  }
}

/**
 * `--settings` args for the session's mode. Work mode only; every other mode
 * (and legacy sessions with no stamp) gets exactly what it got before.
 *
 * `--settings` adds a `flagSettings` source alongside user/project/local/policy
 * settings, so this never replaces or weakens anything the user configured.
 */
export function buildOutboundPolicyArgs(
  mode: string | null | undefined,
  dir?: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (mode !== 'work') return []
  const settingsPath = writeOutboundPolicy(dir ?? getPolicyDir(), platform)
  return settingsPath ? ['--settings', settingsPath] : []
}
