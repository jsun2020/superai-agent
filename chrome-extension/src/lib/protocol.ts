/**
 * The subset of the server's WebSocket protocol the side panel uses.
 * Source of truth: src/server/ws/events.ts. Kept minimal on purpose - the
 * panel is a thin client; anything it does not understand is ignored.
 */

export type AttachmentRef = {
  type: 'file' | 'image'
  name?: string
  data?: string // base64 for images
  mimeType?: string
}

export type ClientMessage =
  | { type: 'user_message'; content: string; attachments?: AttachmentRef[] }
  | { type: 'permission_response'; requestId: string; allowed: boolean }
  | { type: 'stop_generation' }
  | { type: 'ping' }

export type ChatState = 'idle' | 'thinking' | 'tool_executing' | 'streaming' | 'permission_pending'

export type ServerMessage =
  | { type: 'connected'; sessionId: string }
  | { type: 'content_start'; blockType: 'text' | 'tool_use'; toolName?: string; toolUseId?: string; parentToolUseId?: string }
  | { type: 'content_delta'; text?: string; toolInput?: string }
  | { type: 'tool_use_complete'; toolName: string; toolUseId: string; input: unknown; parentToolUseId?: string }
  | { type: 'tool_result'; toolUseId: string; content: unknown; isError: boolean; parentToolUseId?: string }
  | { type: 'permission_request'; requestId: string; toolName: string; toolUseId?: string; input: unknown; description?: string }
  | { type: 'message_complete'; usage?: unknown }
  | { type: 'thinking'; text: string }
  | { type: 'status'; state: ChatState; verb?: string }
  | { type: 'error'; message: string; code: string; retryable?: boolean }
  | { type: 'pong' }
  // Events the panel does not use (team_update, task_update, ...) arrive as
  // well; the reducer ignores any type it does not know, so they need no
  // member here - a catch-all member would erase narrowing for all the others.
