import * as React from 'react'
import { useMemo } from 'react'
import { Text } from '../../ink.js'
import { getRecentActivitySync } from '../../utils/logoV2Utils.js'
import {
  buildPreviousSessionHint,
  wasResumedAtLaunch,
} from '../../utils/previousSessionHint.js'

type Props = {
  /** Columns available for the header's text column. */
  maxWidth: number
}

/**
 * One dim line under the condensed header when a FRESH session starts in a
 * folder that already has sessions:
 *
 *   Last session 2h ago: fix the provider setup · superai -c continues it · /resume picks another
 *
 * The full (release-notes) header already lists recent activity with a
 * "/resume for more" footer, so this only lives in the condensed one. Data
 * comes from the same preloaded recent-activity cache the full header uses
 * (current session and sidechains already filtered out); a session launched
 * with --continue/--resume shows nothing.
 */
export function PreviousSessionsHint({ maxWidth }: Props): React.ReactNode {
  const hint = useMemo(() => {
    if (wasResumedAtLaunch()) return null
    return buildPreviousSessionHint(getRecentActivitySync(), { width: maxWidth })
  }, [maxWidth])
  if (!hint) return null
  return <Text dimColor>{hint}</Text>
}
