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

/**
 * Optional workplace role within Work mode, picked from the cards on the new
 * session screen. There is deliberately no 'office' role: no role at all IS
 * the document experience that WORK_MODE_PROMPT already describes.
 */
export type SessionRole = 'assistant' | 'sales' | 'analyst'

export const SESSION_ROLES: readonly SessionRole[] = [
  'assistant',
  'sales',
  'analyst',
] as const

export function isSessionRole(value: unknown): value is SessionRole {
  return (
    value === 'assistant' || value === 'sales' || value === 'analyst'
  )
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
 * Role framing appended after WORK_MODE_PROMPT when the user picked a role.
 * Each one points the main session at the matching built-in subagent and
 * restates that role's single most consequential rule, so the guard survives
 * even if the session never delegates.
 *
 * ASCII-only: these are passed as CLI arguments on Windows.
 */
export const ROLE_PROMPTS: Record<SessionRole, string> = {
  assistant: `The user has chosen the Assistant role. Their work centres on their inbox, calendar, and meetings.
- Delegate this work to the 'assistant' subagent via the Agent tool; it knows the triage, drafting and meeting-prep conventions.
- Draft, never send. Before any outbound message or calendar change, show the exact content and recipients and wait for an explicit yes.`,
  sales: `The user has chosen the Sales role. Their work centres on accounts, prospects, deals, and CRM records.
- Delegate this work to the 'sales' subagent via the Agent tool; it knows the research, follow-up and CRM conventions.
- Never invent a price, discount, delivery date or commitment. Anything not present in a source the user gave you is [TBD - confirm], and outbound messages are drafted for approval, never sent.`,
  analyst: `The user has chosen the Analyst role. Their work centres on turning spreadsheets and exported data into reports and decisions.
- Delegate this work to the 'analyst' subagent via the Agent tool; it knows the reporting and data-hygiene conventions.
- Lead with the finding, state the data source and the period covered, report any rows dropped, and never write over the user's raw data.`,
}

/**
 * Extra CLI args for a session's mode and role. Only 'work' adds anything;
 * 'code', null (legacy sessions with no stamp), and undefined are the status
 * quo. A role outside Work mode is ignored by design, so a stray stamp can
 * never change the Code experience.
 */
export function buildModeCliArgs(
  mode: string | null | undefined,
  role?: string | null | undefined,
): string[] {
  if (mode !== 'work') return []

  const prompt = isSessionRole(role)
    ? `${WORK_MODE_PROMPT}\n\n${ROLE_PROMPTS[role]}`
    : WORK_MODE_PROMPT

  return ['--append-system-prompt', prompt]
}
