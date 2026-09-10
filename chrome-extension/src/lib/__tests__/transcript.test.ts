import { describe, expect, test } from 'bun:test'
import {
  addUserMessage,
  decidePermission,
  emptyTranscript,
  pendingPermissions,
  reduceServerMessage,
  type TextItem,
  type ToolItem,
} from '../transcript'
import type { ServerMessage } from '../protocol'

function run(msgs: ServerMessage[], start = emptyTranscript()) {
  return msgs.reduce(reduceServerMessage, start)
}

describe('transcript reducer', () => {
  test('streams text deltas into one assistant bubble and goes idle on complete', () => {
    const t = run([
      { type: 'content_start', blockType: 'text' },
      { type: 'content_delta', text: 'Hel' },
      { type: 'content_delta', text: 'lo' },
      { type: 'message_complete' },
    ], addUserMessage(emptyTranscript(), 'hi'))
    expect(t.items.map((i) => i.kind)).toEqual(['text', 'text'])
    expect((t.items[1] as TextItem)).toMatchObject({ role: 'assistant', text: 'Hello' })
    expect(t.state).toBe('idle')
    expect(t.openText).toBeNull()
  })

  test('text -> tool -> text keeps the order visible as separate items', () => {
    const t = run([
      { type: 'content_start', blockType: 'text' },
      { type: 'content_delta', text: 'Let me read it.' },
      { type: 'content_start', blockType: 'tool_use', toolName: 'Read', toolUseId: 'tu1' },
      { type: 'content_delta', toolInput: '{"file_path":' },
      { type: 'content_delta', toolInput: '"a.js"}' },
      { type: 'tool_use_complete', toolName: 'Read', toolUseId: 'tu1', input: { file_path: 'a.js' } },
      { type: 'tool_result', toolUseId: 'tu1', content: 'const a = 1', isError: false },
      { type: 'content_start', blockType: 'text' },
      { type: 'content_delta', text: 'Found it.' },
      { type: 'message_complete' },
    ])
    expect(t.items.map((i) => i.kind)).toEqual(['text', 'tool', 'text'])
    const tool = t.items[1] as ToolItem
    expect(tool).toMatchObject({ toolName: 'Read', input: { file_path: 'a.js' }, inputText: '{"file_path":"a.js"}', done: true, isError: false, result: 'const a = 1' })
    expect((t.items[2] as TextItem).text).toBe('Found it.')
  })

  test('a delta arriving with no open block still renders (reconnect mid-stream)', () => {
    const t = run([{ type: 'content_delta', text: 'orphan' }])
    expect(t.items).toHaveLength(1)
    expect((t.items[0] as TextItem).text).toBe('orphan')
  })

  test('permission requests are surfaced, pending until decided', () => {
    let t = run([{ type: 'permission_request', requestId: 'r1', toolName: 'Edit', input: { file_path: 'a.js' }, description: 'Edit a.js' }])
    expect(t.state).toBe('permission_pending')
    expect(pendingPermissions(t).map((p) => p.requestId)).toEqual(['r1'])
    t = decidePermission(t, 'r1', true)
    expect(pendingPermissions(t)).toHaveLength(0)
    expect(t.state).toBe('thinking')
  })

  test('a tool_result for an unknown tool id is ignored', () => {
    const t = run([{ type: 'tool_result', toolUseId: 'nope', content: 'x', isError: true }])
    expect(t.items).toHaveLength(0)
  })

  test('errors become items and end the turn', () => {
    const t = run([
      { type: 'content_start', blockType: 'text' },
      { type: 'content_delta', text: 'partial' },
      { type: 'error', message: 'API Error: 500', code: 'api_error', retryable: true },
    ])
    expect(t.items.map((i) => i.kind)).toEqual(['text', 'error'])
    expect(t.state).toBe('idle')
  })

  test('unknown event types are ignored, not thrown', () => {
    const t = run([{ type: 'team_update', teamName: 'x', members: [] } as unknown as ServerMessage])
    expect(t).toEqual(emptyTranscript())
  })

  test('user messages record what context travelled with them', () => {
    const t = addUserMessage(emptyTranscript(), 'why?', '3 console, 1 failed request', 1)
    expect(t.items[0]).toMatchObject({ role: 'user', text: 'why?', contextSummary: '3 console, 1 failed request', attachments: 1 })
  })
})
