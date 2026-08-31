/**
 * Splice dictated text into what the user has already typed.
 *
 * Extracted from the composer so it can be tested: dictating into a half-written
 * message is the case that actually matters, and appending or assigning would
 * silently destroy or reorder the user's words. It is reached from a React state
 * updater, which no test here can drive.
 */
export function insertAtCaret(
  current: string,
  caretAt: number,
  text: string,
): { next: string; caret: number } {
  const value = text.trim()
  if (!value) return { next: current, caret: caretAt }

  // A caret from a stale render can point outside the current text.
  const at = Math.max(0, Math.min(caretAt, current.length))
  const before = current.slice(0, at)
  const after = current.slice(at)

  // Add a space only where one is genuinely missing, so dictation neither runs
  // words together nor accumulates double spaces on repeated utterances.
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const tail = after && !/^\s/.test(after) ? ' ' : ''

  return {
    next: `${before}${lead}${value}${tail}${after}`,
    // Caret lands after the inserted words, so the next utterance continues
    // from where this one ended rather than jumping to the end of the field.
    caret: before.length + lead.length + value.length,
  }
}
