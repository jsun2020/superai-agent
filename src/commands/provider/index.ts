import type { Command } from '../../commands.js'

/**
 * SuperAI: configure the model provider (preset / API key / custom endpoint)
 * from inside a session - the same store the first-run setup and the desktop
 * app write (~/.claude/superai). Complements /login, which is Claude Code's
 * Anthropic-account flow.
 */
export default {
  type: 'local-jsx',
  name: 'provider',
  aliases: ['providers'],
  description: 'Configure the model provider (base URL + API key)',
  load: () => import('./provider.js'),
} satisfies Command
