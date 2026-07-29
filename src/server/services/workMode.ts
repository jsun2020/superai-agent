/**
 * Work/Code session modes.
 *
 * "Work" targets general (non-programmer) office users; "Code" is the
 * existing developer experience and adds nothing. The mode is chosen in the
 * desktop UI, stamped on the session's session-meta JSONL entry at creation,
 * and applied at spawn time as an --append-system-prompt steer, so the base
 * coding system prompt and all tooling stay intact.
 */

export type SessionMode = 'work' | 'code'

export function isSessionMode(value: unknown): value is SessionMode {
  return value === 'work' || value === 'code'
}

// ASCII-only: this string is passed as a CLI argument on Windows.
export const WORK_MODE_PROMPT = `SuperAI Agent is running in Work mode, made for general office users rather than developers.
- Assume the user is not a programmer: explain in plain language, avoid jargon, and do not show code unless they ask. Present results as files, tables, and short summaries.
- For any task involving office documents or media - PowerPoint (.pptx), Excel (.xlsx/.csv), Word (.docx), PDF, images, or video - delegate to the 'office' subagent via the Agent tool instead of doing it inline; it knows the preferred document toolchain.
- Typical Work-mode requests: building or editing slide decks, analyzing spreadsheets, filling contract/form/invoice templates, converting documents, organizing and renaming files, and summarizing reports.
- Never modify the user's original files in place; write output to a new file (or a backup copy first) and always report the absolute path of every file you produce.
- Verify deliverables before reporting done (reopen the file, check page/slide/sheet counts).
- Coding questions are still fine to answer, but do not assume a software project context - no repos, builds, or test suites unless the user brings them up.`

/**
 * Extra CLI args for a session's mode. Only 'work' adds anything; 'code',
 * null (legacy sessions with no stamp), and undefined are the status quo.
 */
export function buildModeCliArgs(mode: string | null | undefined): string[] {
  if (mode === 'work') {
    return ['--append-system-prompt', WORK_MODE_PROMPT]
  }
  return []
}
