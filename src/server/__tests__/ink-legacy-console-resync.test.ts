/**
 * Legacy Windows console (conhost) draws East-Asian-Ambiguous glyphs such as
 * `·` in TWO cells when the console font is CJK, while Ink measures them as
 * one. Without a column re-sync the terminal cursor runs ahead of the virtual
 * one, wraps early at the last column, and every later relative move lands a
 * row too low — the "two separator lines / duplicated hint line" ghosting
 * seen when the startup notice replaces the prompt's top border.
 *
 * These tests pin the diff ops LogUpdate emits for exactly that transition.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Diff, Frame } from '../../ink/frame.js'
import { LogUpdate } from '../../ink/log-update.js'
import {
  CellWidth,
  CharPool,
  createScreen,
  HyperlinkPool,
  setCellAt,
  StylePool,
} from '../../ink/screen.js'

const WIDTH = 120

const stylePool = new StylePool()
const charPool = new CharPool()
const hyperlinkPool = new HyperlinkPool()

/** Build a one-row-per-string frame; wide chars are not needed here. */
function frame(rows: string[], cursor = { x: 0, y: rows.length, visible: true }): Frame {
  const screen = createScreen(WIDTH, rows.length, stylePool, charPool, hyperlinkPool)
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      setCellAt(screen, x, y, {
        char: row[x]!,
        styleId: stylePool.none,
        width: CellWidth.Narrow,
        hyperlink: undefined,
      })
    }
  })
  return { screen, viewport: { width: WIDTH, height: 30 }, cursor }
}

const BORDER = '─'.repeat(WIDTH)

function render(prev: Frame, next: Frame): Diff {
  return new LogUpdate({ isTTY: true, stylePool }).render(prev, next)
}

/** The op right after the stdout op that wrote `char`. */
function opAfter(diff: Diff, char: string): Diff[number] | undefined {
  const i = diff.findIndex(op => op.type === 'stdout' && op.content === char)
  return i === -1 ? undefined : diff[i + 1]
}

function stdoutText(diff: Diff): string {
  return diff.map(op => (op.type === 'stdout' ? op.content : '')).join('')
}

const originalPlatform = process.platform
const originalEnv = { WT_SESSION: process.env.WT_SESSION, TERM_PROGRAM: process.env.TERM_PROGRAM }

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

beforeEach(() => {
  delete process.env.WT_SESSION
  delete process.env.TERM_PROGRAM
})

afterEach(() => {
  setPlatform(originalPlatform)
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('Ink column re-sync after ambiguous-width glyphs (conhost)', () => {
  test('on Windows, a `·` that overwrites a border row is followed by a cursorTo of the next column', () => {
    setPlatform('win32')
    // The startup notice line as it appears once memory files have loaded,
    // replacing the prompt's former top border on the same row.
    const notice = ' Large CLAUDE.md will impact performance (153.2k chars > 40.0k) · /memory to edit'
    const diff = render(frame([BORDER]), frame([notice]))
    const dotX = notice.indexOf('·')
    expect(opAfter(diff, '·')).toEqual({ type: 'cursorTo', col: dotX + 2 })
  })

  test('the erase of the old border still runs to the last column, so the re-sync is what prevents the early wrap', () => {
    setPlatform('win32')
    const notice = ' Large CLAUDE.md · /memory to edit'
    const diff = render(frame([BORDER]), frame([notice]))
    // Every border cell past the notice is overwritten with a space
    // (WIDTH - notice.length of them) — the last one lands on column 119.
    const spaces = diff.filter(op => op.type === 'stdout' && op.content === ' ').length
    expect(spaces).toBeGreaterThanOrEqual(WIDTH - notice.length)
  })

  test('box-drawing glyphs (borders) are never compensated — they are narrow in conhost and would double the frame size', () => {
    setPlatform('win32')
    const diff = render(frame(['']), frame([BORDER]))
    expect(diff.some(op => op.type === 'cursorTo')).toBe(false)
  })

  test('ASCII text is never compensated', () => {
    setPlatform('win32')
    const diff = render(frame(['']), frame(['plain ascii > prompt']))
    expect(diff.some(op => op.type === 'cursorTo')).toBe(false)
  })

  test('control: on other platforms the same `·` line emits no cursorTo', () => {
    setPlatform('linux')
    const notice = ' Large CLAUDE.md · /memory to edit'
    const diff = render(frame([BORDER]), frame([notice]))
    expect(diff.some(op => op.type === 'cursorTo')).toBe(false)
  })

  test('at the last column, conhost gets a space instead of the glyph (it would wrap the glyph to the next row)', () => {
    setPlatform('win32')
    const row = 'x'.repeat(WIDTH - 1) + '·'
    const diff = render(frame(['']), frame([row]))
    expect(stdoutText(diff)).toContain('x'.repeat(WIDTH - 1) + ' ')
    expect(stdoutText(diff)).not.toContain('·')
  })

  test('at the last column under Windows Terminal (WT_SESSION) the glyph is written as-is', () => {
    setPlatform('win32')
    process.env.WT_SESSION = 'abc'
    const row = 'x'.repeat(WIDTH - 1) + '·'
    const diff = render(frame(['']), frame([row]))
    expect(stdoutText(diff)).toContain('·')
    // ...and no cursorTo past the edge.
    expect(diff.some(op => op.type === 'cursorTo' && op.col > WIDTH)).toBe(false)
  })
})

describe('terminal badge (Clawd.tsx) stays layout-safe on conhost', () => {
  test('every non-ASCII glyph in the badge is a box-drawing / block element (always one cell in conhost)', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const src = fs.readFileSync(
      path.join(import.meta.dir, '../../components/LogoV2/Clawd.tsx'),
      'utf-8',
    )
    // Only the JSX string literals — the comment above the component may
    // legitimately mention the glyphs it avoids.
    const literals = [...src.matchAll(/\{'([^']*)'\}|>\s*([^<{}\s][^<{}]*)</g)].map(m => m[1] ?? m[2] ?? '')
    const glyphs = new Set([...literals.join('')].filter(ch => ch.codePointAt(0)! >= 0x80))
    expect(glyphs.size).toBeGreaterThan(0)
    for (const g of glyphs) {
      const cp = g.codePointAt(0)!
      expect(cp >= 0x2500 && cp <= 0x259f, `U+${cp.toString(16)} "${g}" is outside box-drawing/block elements`).toBe(true)
    }
    // And the hairline glyphs of the first version are gone.
    expect(glyphs.has('╱')).toBe(false)
    expect(glyphs.has('▁')).toBe(false)
  })
})
