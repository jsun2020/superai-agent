/**
 * Pure reducer from the server's streamed events to what the panel renders.
 * React only draws `Transcript`; every protocol decision lives here so it
 * can be tested without a browser.
 */

import type { ChatState, ServerMessage } from './protocol'

export type TextItem = { kind: 'text'; role: 'user' | 'assistant'; text: string; contextSummary?: string; attachments?: number }
export type ToolItem = { kind: 'tool'; toolUseId: string; toolName: string; input: unknown; inputText: string; result?: unknown; isError?: boolean; done: boolean }
export type PermissionItem = { kind: 'permission'; requestId: string; toolName: string; input: unknown; description?: string; decided?: 'allowed' | 'denied' }
export type ErrorItem = { kind: 'error'; message: string; retryable?: boolean }

export type TranscriptItem = TextItem | ToolItem | PermissionItem | ErrorItem

export type Transcript = {
  items: TranscriptItem[]
  state: ChatState
  /** Index of the assistant text item currently receiving deltas, if any. */
  openText: number | null
  /** Index of the tool item currently receiving input deltas, if any. */
  openTool: number | null
}

export function emptyTranscript(): Transcript {
  return { items: [], state: 'idle', openText: null, openTool: null }
}

export function addUserMessage(t: Transcript, text: string, contextSummary?: string, attachments?: number): Transcript {
  const item: TextItem = { kind: 'text', role: 'user', text }
  if (contextSummary) item.contextSummary = contextSummary
  if (attachments) item.attachments = attachments
  return { ...t, items: [...t.items, item], state: 'thinking', openText: null, openTool: null }
}

export function decidePermission(t: Transcript, requestId: string, allowed: boolean): Transcript {
  return {
    ...t,
    state: 'thinking',
    items: t.items.map((i) =>
      i.kind === 'permission' && i.requestId === requestId ? { ...i, decided: allowed ? 'allowed' : 'denied' } : i,
    ),
  }
}

export function reduceServerMessage(t: Transcript, msg: ServerMessage): Transcript {
  switch (msg.type) {
    case 'content_start': {
      if (msg.blockType === 'text') {
        // A new text block after a tool call starts a new bubble so the order
        // text -> tool -> text is visible.
        const item: TextItem = { kind: 'text', role: 'assistant', text: '' }
        return { ...t, items: [...t.items, item], openText: t.items.length, openTool: null, state: 'streaming' }
      }
      const item: ToolItem = {
        kind: 'tool',
        toolUseId: String(msg.toolUseId ?? ''),
        toolName: String(msg.toolName ?? 'tool'),
        input: undefined,
        inputText: '',
        done: false,
      }
      return { ...t, items: [...t.items, item], openTool: t.items.length, openText: null, state: 'tool_executing' }
    }
    case 'content_delta': {
      if (typeof msg.text === 'string' && msg.text) {
        let items = t.items
        let idx = t.openText
        if (idx === null || items[idx]?.kind !== 'text') {
          // Delta without a start (reconnect mid-stream): open a bubble.
          items = [...items, { kind: 'text', role: 'assistant', text: '' } as TextItem]
          idx = items.length - 1
        }
        const cur = items[idx] as TextItem
        const next = [...items]
        next[idx] = { ...cur, text: cur.text + msg.text }
        return { ...t, items: next, openText: idx, state: 'streaming' }
      }
      if (typeof msg.toolInput === 'string' && t.openTool !== null && t.items[t.openTool]?.kind === 'tool') {
        const cur = t.items[t.openTool] as ToolItem
        const next = [...t.items]
        next[t.openTool] = { ...cur, inputText: cur.inputText + msg.toolInput }
        return { ...t, items: next }
      }
      return t
    }
    case 'tool_use_complete': {
      const idx = t.items.findIndex((i) => i.kind === 'tool' && i.toolUseId === msg.toolUseId)
      const next = [...t.items]
      if (idx >= 0) {
        const cur = next[idx] as ToolItem
        next[idx] = { ...cur, input: msg.input, toolName: msg.toolName || cur.toolName }
      } else {
        next.push({ kind: 'tool', toolUseId: msg.toolUseId, toolName: msg.toolName, input: msg.input, inputText: '', done: false })
      }
      return { ...t, items: next, openTool: null, state: 'tool_executing' }
    }
    case 'tool_result': {
      const idx = t.items.findIndex((i) => i.kind === 'tool' && i.toolUseId === msg.toolUseId)
      if (idx < 0) return t
      const next = [...t.items]
      const cur = next[idx] as ToolItem
      next[idx] = { ...cur, result: msg.content, isError: msg.isError, done: true }
      return { ...t, items: next, state: 'thinking' }
    }
    case 'permission_request': {
      const item: PermissionItem = {
        kind: 'permission',
        requestId: msg.requestId,
        toolName: msg.toolName,
        input: msg.input,
        ...(msg.description ? { description: msg.description } : {}),
      }
      return { ...t, items: [...t.items, item], state: 'permission_pending', openText: null }
    }
    case 'message_complete':
      return { ...t, state: 'idle', openText: null, openTool: null }
    case 'status':
      return typeof msg.state === 'string' ? { ...t, state: msg.state as ChatState } : t
    case 'error': {
      const item: ErrorItem = { kind: 'error', message: String(msg.message ?? 'error'), ...(msg.retryable !== undefined ? { retryable: !!msg.retryable } : {}) }
      return { ...t, items: [...t.items, item], state: 'idle', openText: null, openTool: null }
    }
    default:
      return t
  }
}

/** Pending permission requests, oldest first. */
export function pendingPermissions(t: Transcript): PermissionItem[] {
  return t.items.filter((i): i is PermissionItem => i.kind === 'permission' && !i.decided)
}
