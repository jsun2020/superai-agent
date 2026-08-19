/**
 * SuperAI: "bypass permissions" is part of the Shift+Tab mode cycle by
 * default (default -> accept edits -> plan -> bypass permissions -> default),
 * the way the desktop's permission dropdown offers "Bypass all".
 *
 * Upstream only puts it in the cycle when the process was started with
 * --dangerously-skip-permissions / --permission-mode bypassPermissions. The
 * safety gate is kept: the first time a session cycles INTO bypass, the same
 * warning dialog as at startup is shown (accept persists
 * `skipDangerousModePermissionPrompt`, decline reverts and drops bypass from
 * the cycle for that session), and `permissions.disableBypassPermissionsMode`
 * in settings still removes it entirely.
 *
 * Opt out of the default with SUPERAI_BYPASS_IN_CYCLE=0. Never offered when
 * running as root on Unix outside a sandbox (mirrors the startup check for
 * --dangerously-skip-permissions).
 */
import { isEnvTruthy } from '../envUtils.js'

type EnvLike = Record<string, string | undefined>

export function isBypassModeOfferedByDefault(
  env: EnvLike = process.env,
  platform: NodeJS.Platform = process.platform,
  uid: number | undefined = typeof process.getuid === 'function'
    ? process.getuid()
    : undefined,
): boolean {
  const explicit = env.SUPERAI_BYPASS_IN_CYCLE
  if (explicit !== undefined && explicit !== '') {
    return isEnvTruthy(explicit)
  }
  // root/sudo on Unix outside a sandbox: do not put the unsafe mode one
  // keystroke away (same rule the startup flag enforces).
  if (platform !== 'win32' && uid === 0 && !isEnvTruthy(env.IS_SANDBOX)) {
    return false
  }
  return true
}
