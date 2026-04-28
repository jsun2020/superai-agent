/**
 * Shared helpers for the /send_file feature across IM adapters
 * (WeChat, Feishu, Telegram). Centralised so the user-facing trigger
 * grammar — slash command + Chinese/English natural language — stays
 * consistent and so each adapter only needs to plug its platform-
 * specific upload primitive into the same routing.
 */

/** Match the last absolute filesystem path that looks like a real file
 *  (has an extension) inside a string. Handles Windows backslash paths
 *  ("C:\foo\bar.pptx") and POSIX paths ("/home/user/x.pdf"). */
export const FILE_PATH_REGEX =
  /([A-Za-z]:\\[^\s"'<>|*?\n\r]+\.[A-Za-z0-9]{1,8}|\/[^\s"'<>|*?\n\r]+\.[A-Za-z0-9]{1,8})/g

export function extractLastFilePath(text: string): string | undefined {
  const matches = text.match(FILE_PATH_REGEX)
  if (!matches || matches.length === 0) return undefined
  // Strip trailing closing punctuation that doesn't belong to the path.
  return matches[matches.length - 1]!.replace(/[.,;:)\]}」、]+$/, '')
}

/** Heuristic: did the user ask the bot to deliver a file via natural
 *  language? Catches Chinese ("发给我", "发我", "给我发", "把…发", "发过来",
 *  "传给我") and English ("send (it) to me", "send me"). False positives
 *  are acceptable — sending an extra file is non-destructive — so the
 *  pattern errs on the inclusive side rather than enforce strict NLP. */
export const SEND_TO_ME_REGEX =
  /(?:发(?:给|送|来|过来)?\s*我|给\s*我\s*发|发(?:给|送)\s*过来|传给我|传我|send(?:\s+it)?\s+to\s+me|send\s+me)/i

export function looksLikeSendRequest(text: string): boolean {
  return SEND_TO_ME_REGEX.test(text)
}

/** Format a byte count as a friendly string (e.g. "245.3 KB"). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Match the slash-command form across all our supported aliases. */
const SEND_FILE_COMMANDS = ['/send_file', '/sf', '/发送', '/发我']

export function parseSendFileCommand(text: string): { matched: boolean; arg: string } {
  const trimmed = text.trim()
  for (const cmd of SEND_FILE_COMMANDS) {
    if (trimmed === cmd) return { matched: true, arg: '' }
    if (trimmed.startsWith(cmd + ' ')) return { matched: true, arg: trimmed.slice(cmd.length + 1).trim() }
  }
  return { matched: false, arg: '' }
}

/** Decide whether a path points at a renderable image (so adapters can
 *  pick the inline-photo primitive over the generic file primitive). */
export function isImageFile(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return /\.(png|jpe?g|gif|webp|heic)$/.test(lower)
}
