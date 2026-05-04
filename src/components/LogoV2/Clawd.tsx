import * as React from 'react';
import { Box, Text } from '../../ink.js';

// SuperAI Agent badge — 2D rendering of the brand logo (triangle "A" with
// stylized "S", flat base, vertical "I" bar). 6 cols x 3 rows fits within
// CondensedLogo's 11-col reservation. Pose prop kept for API compat with
// AnimatedClawd but has no visual effect: the badge is static.
export type ClawdPose = 'default' | 'arms-up' | 'look-left' | 'look-right';

type Props = {
  pose?: ClawdPose;
};

export function Clawd(_props: Props = {}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="clawd_body">{' ╱╲  ┃'}</Text>
      </Text>
      <Text>
        <Text color="clawd_body">{'╱ '}</Text>
        <Text color="clawd_body" backgroundColor="clawd_background">S</Text>
        <Text color="clawd_body">{'╲ ┃'}</Text>
      </Text>
      <Text color="clawd_body">{'▁▁▁▁ ┃'}</Text>
    </Box>
  );
}
