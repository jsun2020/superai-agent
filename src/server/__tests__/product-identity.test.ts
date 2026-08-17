import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { PRODUCT_COMMAND, PRODUCT_NAME } from '../../constants/product'

const repoRoot = path.resolve(import.meta.dir, '../../..')
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf-8')

/**
 * The portable TUI ships on machines that also have Anthropic's `claude` CLI.
 * Before v0.2.14 it presented itself identically: `Usage: claude ...`,
 * `0.2.0 (Claude Code)`, a console window titled "claude", and a first-run
 * banner reading "Welcome to Claude Code" — so the two were indistinguishable
 * in shell history, screenshots and bug reports.
 *
 * These are source-structure assertions on purpose. A behavioural test would
 * have to spawn the whole CLI; what actually regresses here is someone
 * re-introducing a hard-coded literal, and that is exactly what this catches.
 */
describe('product identity', () => {
  test('exposes the fork command name, not the upstream one', () => {
    expect(PRODUCT_COMMAND).toBe('superai')
    expect(PRODUCT_NAME).toBe('SuperAI Agent')
    // The whole point is not colliding with the upstream binary on PATH.
    expect(PRODUCT_COMMAND).not.toBe('claude')
  })

  describe('src/main.tsx', () => {
    const main = read('src/main.tsx')

    test('registers the commander program under PRODUCT_COMMAND', () => {
      expect(main).toContain('program.name(PRODUCT_COMMAND)')
      expect(main).not.toContain("program.name('claude')")
    })

    test('reports PRODUCT_NAME from --version', () => {
      expect(main).toContain('`${MACRO.VERSION} (${PRODUCT_NAME})`')
      expect(main).not.toContain('(Claude Code)`')
    })

    test('sets the console/window title from PRODUCT_COMMAND', () => {
      // On Windows process.title *is* the console window title.
      expect(main).toContain('process.title = PRODUCT_COMMAND')
      expect(main).not.toContain("process.title = 'claude'")
    })

    test('no usage or error string tells the user to type `claude`', () => {
      // Matches `claude` only where it is followed by a subcommand or flag,
      // i.e. an instruction to run something. Leaves alone: `.claude` paths,
      // CLAUDE_CODE_* env vars, the "claude" theme colour, model aliases,
      // and the `# claude up` heading contract inside users' CLAUDE.md files.
      // No /g flag: `.test()` on a global regex advances lastIndex between
      // calls and would silently skip every other matching line.
      const commandLike = /(?<![\w./#-])claude (?:--\w|ssh\b|assistant\b|export\b|rollback\b|auth\b|mcp\b)/
      const offenders = main
        .split('\n')
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => {
          const t = line.trim()
          if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false
          return commandLike.test(line)
        })
        .map(([n, line]) => `${n}: ${line.trim().slice(0, 120)}`)

      expect(offenders).toEqual([])
    })
  })

  test('the first-run banner is branded', () => {
    const welcome = read('src/components/LogoV2/WelcomeV2.tsx')
    expect(welcome).toContain(`Welcome to ${PRODUCT_NAME}`)
    expect(welcome).not.toContain('Welcome to Claude Code')
  })

  test('the IDE onboarding banner is branded', () => {
    // Shown the first time a session attaches to VS Code / JetBrains, i.e.
    // still part of "what does this thing call itself when it starts".
    const ide = read('src/components/IdeOnboardingDialog.tsx')
    expect(ide).toContain('Welcome to {PRODUCT_NAME} for {ideName}')
    expect(ide).not.toContain('Welcome to Claude Code')
  })

  test('the --version fast path is branded', () => {
    const cli = read('src/entrypoints/cli.tsx')
    expect(cli).toContain('`${MACRO.VERSION} (${PRODUCT_NAME})`')
    expect(cli).not.toContain('(Claude Code)`')
  })

  test('the portable build ships a matching `superai` command', () => {
    // Printing "Usage: superai" while shipping no superai.exe would be a
    // dead instruction.
    const script = read('scripts/build-portable.ps1')
    expect(script).toContain(`'${PRODUCT_COMMAND}.exe'`)
  })
})
