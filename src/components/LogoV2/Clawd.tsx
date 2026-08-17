import * as React from 'react';
import { Box, Text } from '../../ink.js';

// SuperAI Agent badge — the brand mark (triangle "A" with the "S" curve
// inside, and the vertical "I" bar) rendered as terminal art.
//
//     ▄▀▄   ┃
//    █ S █  ┃
//   █▄▄▄▄▄█ ┃
//
// Drawn with half-block glyphs (▀ ▄ █) rather than the light diagonals
// (╱ ╲ ▁) of the first version: those come out as hairlines in the CJK
// console fonts that Windows ships by default, and the mark disappeared
// next to the border text. ▀ ▄ █ are in every console font (CP437) and the
// legacy Windows console always draws them one cell wide (unlike ● → …),
// so the badge cannot skew the layout either. Triangle and bar take the
// brand colour, the S the blue of the app icon.
//
// 7 cols + gap + bar = 9 cols, inside CondensedLogo's 11-col reservation.
// Pose prop kept for API compat with AnimatedClawd but has no visual
// effect: the badge is static.
export type ClawdPose = 'default' | 'arms-up' | 'look-left' | 'look-right';

type Props = {
  pose?: ClawdPose;
};

export function Clawd(_props: Props = {}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="clawd_body">{'  ▄▀▄   ┃'}</Text>
      </Text>
      <Text>
        <Text color="clawd_body">{' █ '}</Text>
        <Text color="permission" bold>
          S
        </Text>
        <Text color="clawd_body">{' █  ┃'}</Text>
      </Text>
      <Text color="clawd_body">{'█▄▄▄▄▄█ ┃'}</Text>
    </Box>
  );
}
