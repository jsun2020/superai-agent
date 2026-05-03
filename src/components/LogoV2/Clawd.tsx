import * as React from 'react';
import { Box, Text } from '../../ink.js';

// SuperAI Agent badge — replaces the original Claude "Clawd" mascot.
// 5 cols x 3 rows so layout (gap=2 in CondensedLogo) still fits the same
// horizontal slot. Pose prop kept for API compat with AnimatedClawd but
// has no visual effect: the badge is static.
export type ClawdPose = 'default' | 'arms-up' | 'look-left' | 'look-right';

type Props = {
  pose?: ClawdPose;
};

export function Clawd(_props: Props = {}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text color="clawd_body">▛▀▀▀▜</Text>
      <Text>
        <Text color="clawd_body">▌</Text>
        <Text color="clawd_body" backgroundColor="clawd_background">SAI</Text>
        <Text color="clawd_body">▐</Text>
      </Text>
      <Text color="clawd_body">▙▄▄▄▟</Text>
    </Box>
  );
}
