/**
 * "Last session" hint for the TUI's condensed startup header.
 *
 * Sessions are persisted per folder and `superai -c` / `superai -r` /
 * `/resume` bring them back — but the everyday (condensed) header never said
 * so, and Claude Code's occasional tip about it named the wrong binary. This
 * module builds one dim line for the header when a fresh session starts in a
 * folder that already has sessions, so a terminal user learns the commands
 * exactly when they matter.
 */

import { PRODUCT_COMMAND } from '../constants/product.js'
import { formatRelativeTimeAgo } from './format.js'
import { stringWidth } from '../ink/stringWidth.js'
import { truncate } from './truncate.js'

/** The subset of LogOption the hint needs — keeps tests free of session plumbing. */
export type PreviousSessionActivity = {
  summary?: string
  firstPrompt?: string
  modified: Date
}

// ---------------------------------------------------------------------------
// "Was this process launched INTO an earlier session?" (--continue / --resume /
// --from-pr). Set by processResumedConversation, the funnel every CLI-launch
// resume goes through; a resumed session must not tell the user to resume.
// ---------------------------------------------------------------------------
let resumedAtLaunch = false

export function markResumedAtLaunch(): void {
  resumedAtLaunch = true
}

export function wasResumedAtLaunch(): boolean {
  return resumedAtLaunch
}

const CONTINUE_LAST = `${PRODUCT_COMMAND} -c continues it`
const CONTINUE_SHORT = `${PRODUCT_COMMAND} -c continues the last session`
const PICK_ANOTHER = '/resume picks another'

function describe(activity: PreviousSessionActivity): string {
  const raw =
    activity.summary && activity.summary !== 'No prompt'
      ? activity.summary
      : (activity.firstPrompt ?? '')
  return raw.replace(/\s+/g, ' ').trim()
}

/**
 * One line, or null when there is nothing to say (no earlier session, or the
 * header is too narrow for even the short form). Never wider than `width`.
 *
 *   Last session 2 hours ago: fix the provider setup flow · superai -c continues it · /resume picks another
 *   superai -c continues the last session · /resume picks another        (narrow header)
 */
export function buildPreviousSessionHint(
  activities: PreviousSessionActivity[],
  options: { width: number; now?: Date },
): string | null {
  const last = activities[0]
  if (!last) return null

  const { width, now } = options
  const age = formatRelativeTimeAgo(last.modified, now ? { now } : {})
  const prefix = `Last session ${age}: `
  const suffix = ` · ${CONTINUE_LAST} · ${PICK_ANOTHER}`
  const description = describe(last)

  // Long form: leave at least a few characters of description or it reads as noise.
  const roomForDescription = width - stringWidth(prefix) - stringWidth(suffix)
  if (description && roomForDescription >= 8) {
    return `${prefix}${truncate(description, roomForDescription)}${suffix}`
  }

  const short = `${CONTINUE_SHORT} · ${PICK_ANOTHER}`
  return stringWidth(short) <= width ? short : null
}
