import { describe, expect, test } from 'bun:test'
import { upsertManagedPathBlock } from '../services/desktopCliLauncherService.js'

const NEW_BLOCK = [
  '# >>> SuperAI Agent PATH >>>',
  'export PATH="$HOME/.local/bin:$PATH"',
  '# <<< SuperAI Agent PATH <<<',
].join('\n')

describe('upsertManagedPathBlock', () => {
  test('appends the block to a profile that has none', () => {
    const result = upsertManagedPathBlock('# my profile\n', NEW_BLOCK)
    expect(result).toContain('# >>> SuperAI Agent PATH >>>')
    expect(result).toContain('# my profile')
  })

  test('replaces an existing block in place', () => {
    const existing = `# top\n${NEW_BLOCK}\n# bottom\n`
    const updated = NEW_BLOCK.replace('.local/bin', '.local/other')
    const result = upsertManagedPathBlock(existing, updated)
    expect(result).toContain('.local/other')
    expect(result).not.toContain('.local/bin:')
    expect(result.match(/>>> SuperAI Agent PATH >>>/g)).toHaveLength(1)
  })

  test('migrates a legacy Claude Code Haha block instead of duplicating', () => {
    const legacy = [
      '# profile start',
      '# >>> Claude Code Haha PATH >>>',
      'export PATH="$HOME/.local/bin:$PATH"',
      '# <<< Claude Code Haha PATH <<<',
      '# profile end',
    ].join('\n')
    const result = upsertManagedPathBlock(legacy, NEW_BLOCK)
    expect(result).not.toContain('Claude Code Haha')
    expect(result).toContain('# >>> SuperAI Agent PATH >>>')
    expect(result.match(/PATH >>>/g)).toHaveLength(1)
    expect(result).toContain('# profile start')
    expect(result).toContain('# profile end')
  })
})
