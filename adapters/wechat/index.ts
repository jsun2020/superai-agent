/**
 * WeChat Adapter for Claude Code Desktop
 *
 * Native re-implementation of the Tencent ilink-bot wire protocol — speaks
 * the same HTTP API as `@tencent-weixin/openclaw-weixin-cli` but plugs into
 * cc-haha's adapter system (Desktop Webapp Settings → IM 接入 pairing,
 * server `/api/sessions` + `/ws/:sessionId`) the same way the Telegram and
 * Feishu adapters do.
 *
 * Run: bun run wechat:login   # one-time, scan QR to register an account
 *      bun run wechat         # start the long-poll loop
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { WsBridge, type ServerMessage, type AttachmentRef } from '../common/ws-bridge.js'
import { MessageDedup } from '../common/message-dedup.js'
import { enqueue } from '../common/chat-queue.js'
import { loadConfig } from '../common/config.js'
import {
  formatImHelp,
  formatImStatus,
  formatPermissionRequest,
  splitMessage,
  WECHAT_PERMISSION_HINT,
} from '../common/format.js'
import { SessionStore } from '../common/session-store.js'
import { AdapterHttpClient } from '../common/http-client.js'
import { isAllowedUser, tryPair } from '../common/pairing.js'
import { AttachmentStore } from '../common/attachment/attachment-store.js'
import { checkAttachmentLimit } from '../common/attachment/attachment-limits.js'
import { ImageBlockWatcher } from '../common/attachment/image-block-watcher.js'
import type { PendingUpload } from '../common/attachment/attachment-types.js'

import { listAccounts, loadAccount, loadSyncCursor, saveSyncCursor } from './account-store.js'
import {
  TOKEN_EXPIRED_PAUSE_MS,
  WX_ENDPOINTS,
  WX_ERR_TOKEN_EXPIRED,
  WX_ITEM_TYPE,
  WeixinClient,
  type WeixinMessage,
} from './client.js'
import { extractInboundPayload } from './extract-payload.js'
import { WeixinMediaService } from './media.js'

const WECHAT_TEXT_LIMIT = 1500 // soft cap; long replies split into multiple sends

// ---------- init ----------

const config = loadConfig()

const account = (() => {
  if (config.wechat.accountId) {
    const loaded = loadAccount(config.wechat.accountId)
    if (loaded) return loaded
    console.error(`[Wechat] No saved account for id=${config.wechat.accountId}`)
    process.exit(1)
  }
  const all = listAccounts()
  if (all.length === 0) {
    console.error('[Wechat] No accounts found. Run: bun run wechat:login')
    process.exit(1)
  }
  return all[0]!
})()

const client = new WeixinClient(account.baseUrl, account.token)
const bridge = new WsBridge(config.serverUrl, 'wechat')
const dedup = new MessageDedup()
const sessionStore = new SessionStore()
const httpClient = new AdapterHttpClient(config.serverUrl)
const attachmentStore = new AttachmentStore()
const media = new WeixinMediaService(client, attachmentStore)
attachmentStore.gc().catch((err) => {
  console.warn('[Wechat] AttachmentStore.gc failed:', err instanceof Error ? err.message : err)
})

type ChatRuntimeState = {
  state: 'idle' | 'thinking' | 'streaming' | 'tool_executing' | 'permission_pending'
  verb?: string
  model?: string
  pendingPermissionCount: number
  /** Most-recent un-resolved permission request id, used so the user can
   *  reply with a plain "y" / "n" instead of typing the full id. */
  lastPermissionRequestId?: string
  /** Most recent context_token from the user. Required by the WeChat
   *  send API to thread replies under the user-initiated session. */
  contextToken?: string
  /** When true, every incoming permission_request in the current assistant
   *  turn is auto-approved without prompting the user. Cleared on
   *  `message_complete` (one assistant turn = one auto-approve scope). */
  permitAllInTurn: boolean
  /** Last absolute filesystem path the assistant mentioned in this chat,
   *  captured from streamed text. Used as the default target for
   *  /send_file when the user invokes it without an argument. */
  lastMentionedFilePath?: string
}

const runtimeStates = new Map<string, ChatRuntimeState>()
const pendingProjectSelection = new Map<string, boolean>()
/** Buffered streaming output, flushed on message_complete. */
const streamingBuffers = new Map<string, string>()
/** Outbound markdown-image watcher per chat. */
const imageWatchers = new Map<string, ImageBlockWatcher>()

let stopped = false
let pauseUntil = 0

function getRuntimeState(chatId: string): ChatRuntimeState {
  let s = runtimeStates.get(chatId)
  if (!s) {
    s = { state: 'idle', pendingPermissionCount: 0, permitAllInTurn: false }
    runtimeStates.set(chatId, s)
  }
  return s
}

function getImageWatcher(chatId: string): ImageBlockWatcher {
  let w = imageWatchers.get(chatId)
  if (!w) {
    w = new ImageBlockWatcher()
    imageWatchers.set(chatId, w)
  }
  return w
}

function clearTransientChatState(chatId: string): void {
  streamingBuffers.delete(chatId)
  imageWatchers.delete(chatId)
  const s = getRuntimeState(chatId)
  s.state = 'idle'
  s.verb = undefined
  s.pendingPermissionCount = 0
  s.lastPermissionRequestId = undefined
  s.permitAllInTurn = false
  s.lastMentionedFilePath = undefined
}

// ---------- send helpers ----------

async function sendTextRaw(toUserId: string, text: string, contextToken?: string): Promise<void> {
  const chunks = splitMessage(text, WECHAT_TEXT_LIMIT)
  for (const chunk of chunks) {
    try {
      const resp = await client.sendMessage({
        to_user_id: toUserId,
        context_token: contextToken,
        item_list: [{ type: WX_ITEM_TYPE.TEXT, text_item: { text: chunk } }],
      })
      if (resp.ret !== 0) {
        if (resp.errcode === WX_ERR_TOKEN_EXPIRED) {
          enterTokenExpiredPause()
          return
        }
        console.error(`[Wechat] sendMessage ret=${resp.ret} errcode=${resp.errcode} ${resp.errmsg ?? ''}`)
      }
    } catch (err) {
      console.error('[Wechat] sendMessage error:', err instanceof Error ? err.message : err)
    }
  }
}

async function sendText(chatId: string, text: string): Promise<void> {
  const runtime = getRuntimeState(chatId)
  await sendTextRaw(chatId, text, runtime.contextToken)
}

/** Format a byte count as a friendly string (e.g. "245.3 KB"). */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Read a local file and ship it to the user via WeChat outbound media.
 *  On any protocol failure, reply with a text fallback containing the
 *  metadata + path so the user can retrieve via the desktop app. Image
 *  files are delivered via sendImageMessage so WeChat displays them inline. */
async function sendFileToUser(chatId: string, filePath: string): Promise<void> {
  const runtime = getRuntimeState(chatId)
  let buffer: Buffer
  try {
    buffer = await fs.readFile(filePath)
  } catch (err) {
    await sendText(chatId, `❌ 无法读取文件: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  const fileName = path.basename(filePath)
  const ext = path.extname(fileName).toLowerCase()
  const isImage = /^\.(png|jpe?g|gif|webp|heic)$/.test(ext)
  const kind: 'image' | 'file' = isImage ? 'image' : 'file'

  const check = checkAttachmentLimit(kind, buffer.length)
  if (!check.ok) {
    await sendText(chatId, `❌ ${check.hint}\n路径: ${filePath}`)
    return
  }

  try {
    if (isImage) {
      await media.sendImageMessage(chatId, buffer, runtime.contextToken)
    } else {
      await media.sendFileMessage(chatId, buffer, fileName, runtime.contextToken)
    }
    runtime.lastMentionedFilePath = filePath
  } catch (err) {
    console.error('[Wechat] sendFileToUser failed:', err instanceof Error ? err.message : err)
    await sendText(
      chatId,
      `📎 文件: ${fileName} (${formatSize(buffer.length)})\n路径: ${filePath}\n` +
        `⚠️ 直传失败 (${err instanceof Error ? err.message : err})。请在桌面端打开会话目录获取。`,
    )
  }
}

async function dispatchOutboundImage(chatId: string, pending: PendingUpload): Promise<void> {
  try {
    let buffer: Buffer
    let mime = 'image/png'
    switch (pending.source.kind) {
      case 'base64':
        buffer = Buffer.from(pending.source.data, 'base64')
        mime = pending.source.mime
        break
      case 'path':
        buffer = await fs.readFile(pending.source.path)
        mime = pending.source.mime ?? 'image/png'
        break
      case 'url': {
        const resp = await fetch(pending.source.url)
        if (!resp.ok) throw new Error(`fetch ${pending.source.url} -> ${resp.status}`)
        buffer = Buffer.from(await resp.arrayBuffer())
        mime = pending.source.mime ?? resp.headers.get('content-type') ?? 'image/png'
        break
      }
    }
    const check = checkAttachmentLimit('image', buffer.length, mime)
    if (!check.ok) {
      console.warn('[Wechat] Outbound image rejected:', check.hint)
      return
    }
    const runtime = getRuntimeState(chatId)
    await media.sendImageMessage(chatId, buffer, runtime.contextToken)
  } catch (err) {
    console.error('[Wechat] dispatchOutboundImage failed:', err instanceof Error ? err.message : err)
  }
}

// ---------- session management ----------

async function ensureExistingSession(
  chatId: string,
): Promise<{ sessionId: string; workDir: string } | null> {
  const stored = sessionStore.get(chatId)
  if (!stored) return null
  if (!bridge.hasSession(chatId)) {
    bridge.connectSession(chatId, stored.sessionId)
    bridge.onServerMessage(chatId, (msg) => handleServerMessage(chatId, msg))
    const opened = await bridge.waitForOpen(chatId)
    if (!opened) return null
  }
  return stored
}

async function ensureSession(chatId: string): Promise<boolean> {
  if (bridge.hasSession(chatId)) return true
  const stored = sessionStore.get(chatId)
  if (stored) {
    bridge.connectSession(chatId, stored.sessionId)
    bridge.onServerMessage(chatId, (msg) => handleServerMessage(chatId, msg))
    return await bridge.waitForOpen(chatId)
  }
  const workDir = config.wechat.defaultWorkDir || config.defaultProjectDir
  if (workDir) return await createSessionForChat(chatId, workDir)
  await showProjectPicker(chatId)
  return false
}

async function createSessionForChat(chatId: string, workDir: string): Promise<boolean> {
  try {
    bridge.resetSession(chatId)
    const sessionId = await httpClient.createSession(workDir)
    sessionStore.set(chatId, sessionId, workDir)
    bridge.connectSession(chatId, sessionId)
    bridge.onServerMessage(chatId, (msg) => handleServerMessage(chatId, msg))
    const opened = await bridge.waitForOpen(chatId)
    if (!opened) {
      await sendText(chatId, '⚠️ 连接服务器超时，请重试。')
      return false
    }
    return true
  } catch (err) {
    await sendText(chatId, `❌ 无法创建会话: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

async function showProjectPicker(chatId: string): Promise<void> {
  try {
    const projects = await httpClient.listRecentProjects()
    if (projects.length === 0) {
      await sendText(
        chatId,
        '没有找到最近的项目。请先在 Desktop App 中打开一个项目，或在 Settings → IM 接入中配置默认项目。',
      )
      return
    }
    const lines = projects.slice(0, 10).map((p, i) =>
      `${i + 1}. ${p.projectName}${p.branch ? ` (${p.branch})` : ''}\n   ${p.realPath}`,
    )
    pendingProjectSelection.set(chatId, true)
    await sendText(
      chatId,
      `选择项目（回复编号）：\n\n${lines.join('\n\n')}\n\n💡 下次可直接 /new <编号或名称> 快速新建会话`,
    )
  } catch (err) {
    await sendText(chatId, `❌ 无法获取项目列表: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function startNewSession(chatId: string, query?: string): Promise<void> {
  bridge.resetSession(chatId)
  sessionStore.delete(chatId)
  clearTransientChatState(chatId)
  pendingProjectSelection.delete(chatId)
  runtimeStates.delete(chatId)

  if (query) {
    try {
      const { project, ambiguous } = await httpClient.matchProject(query)
      if (project) {
        const ok = await createSessionForChat(chatId, project.realPath)
        if (ok) {
          await sendText(
            chatId,
            `✅ 已新建会话：${project.projectName}${project.branch ? ` (${project.branch})` : ''}`,
          )
        }
        return
      }
      if (ambiguous) {
        const list = ambiguous.map((p, i) => `${i + 1}. ${p.projectName} — ${p.realPath}`).join('\n')
        await sendText(chatId, `匹配到多个项目，请更精确：\n\n${list}`)
        return
      }
      await sendText(chatId, `未找到匹配 "${query}" 的项目。发送 /projects 查看完整列表。`)
    } catch (err) {
      await sendText(chatId, `❌ ${err instanceof Error ? err.message : String(err)}`)
    }
    return
  }

  const workDir = config.wechat.defaultWorkDir || config.defaultProjectDir
  if (workDir) {
    const ok = await createSessionForChat(chatId, workDir)
    if (ok) await sendText(chatId, '✅ 已新建会话，可以开始对话了。')
  } else {
    await showProjectPicker(chatId)
  }
}

async function buildStatusText(chatId: string): Promise<string> {
  const stored = await ensureExistingSession(chatId)
  if (!stored) return formatImStatus(null)
  const runtime = getRuntimeState(chatId)
  let projectName = path.basename(stored.workDir) || stored.workDir
  let branch: string | null = null
  try {
    const gitInfo = await httpClient.getGitInfo(stored.sessionId)
    projectName = gitInfo.repoName || path.basename(gitInfo.workDir) || projectName
    branch = gitInfo.branch
  } catch {}
  let taskCounts:
    | { total: number; pending: number; inProgress: number; completed: number }
    | undefined
  try {
    const tasks = await httpClient.getTasksForSession(stored.sessionId)
    if (tasks.length > 0) {
      taskCounts = {
        total: tasks.length,
        pending: tasks.filter((t) => t.status === 'pending').length,
        inProgress: tasks.filter((t) => t.status === 'in_progress').length,
        completed: tasks.filter((t) => t.status === 'completed').length,
      }
    }
  } catch {}
  return formatImStatus({
    sessionId: stored.sessionId,
    projectName,
    branch,
    model: runtime.model,
    state: runtime.state,
    verb: runtime.verb,
    pendingPermissionCount: runtime.pendingPermissionCount,
    taskCounts,
  })
}

// ---------- server message handler ----------

async function handleServerMessage(chatId: string, msg: ServerMessage): Promise<void> {
  const runtime = getRuntimeState(chatId)

  switch (msg.type) {
    case 'connected':
      break

    case 'status':
      runtime.state = msg.state
      runtime.verb = typeof msg.verb === 'string' ? msg.verb : undefined
      break

    case 'content_start':
      if (msg.blockType === 'text') {
        // First content block in a turn — initialise the buffer slot so we
        // know to flush at message_complete even if no delta ever arrives.
        if (!streamingBuffers.has(chatId)) streamingBuffers.set(chatId, '')
      } else if (msg.blockType === 'tool_use') {
        // Flush any text we've buffered so far before the tool runs, so
        // the user sees prose ahead of tool side-effects.
        const buffered = streamingBuffers.get(chatId)
        if (buffered && buffered.trim()) {
          await sendText(chatId, buffered)
          streamingBuffers.set(chatId, '')
        }
      }
      break

    case 'content_delta': {
      if (typeof msg.text !== 'string' || !msg.text) break
      const prev = streamingBuffers.get(chatId) ?? ''
      const next = prev + msg.text
      streamingBuffers.set(chatId, next)
      const newUploads = getImageWatcher(chatId).feed(msg.text)
      for (const pending of newUploads) {
        void dispatchOutboundImage(chatId, pending)
      }
      // Track the most recent absolute file path the assistant mentioned so
      // /send_file with no argument can default to it. We scan the freshly
      // appended slice plus a small overlap from the previous buffer to
      // catch paths that span chunk boundaries.
      const overlap = prev.slice(Math.max(0, prev.length - 256))
      const mentioned = extractLastFilePath(overlap + msg.text)
      if (mentioned) runtime.lastMentionedFilePath = mentioned
      break
    }

    case 'thinking':
      // WeChat IM has no inline status indicator; we deliberately drop
      // thinking deltas to avoid flooding the chat with reasoning noise.
      break

    case 'tool_use_complete':
    case 'tool_result':
      break

    case 'permission_request': {
      runtime.pendingPermissionCount += 1
      runtime.state = 'permission_pending'
      runtime.lastPermissionRequestId = msg.requestId
      // Per-turn auto-approve: user replied "ys" earlier in this assistant
      // turn, so silently approve and skip the prompt. Counter is decremented
      // to keep the status panel accurate.
      if (runtime.permitAllInTurn) {
        bridge.sendPermissionResponse(chatId, msg.requestId, true)
        runtime.pendingPermissionCount = Math.max(0, runtime.pendingPermissionCount - 1)
        runtime.lastPermissionRequestId = undefined
        break
      }
      const text =
        formatPermissionRequest(msg.toolName, msg.input, msg.requestId) +
        `\n\n${WECHAT_PERMISSION_HINT}`
      await sendText(chatId, text)
      break
    }

    case 'message_complete': {
      runtime.state = 'idle'
      runtime.verb = undefined
      // Auto-approve scope is one assistant turn — clear it now so the next
      // turn requires fresh confirmation.
      runtime.permitAllInTurn = false
      const buffered = streamingBuffers.get(chatId) ?? ''
      streamingBuffers.delete(chatId)
      imageWatchers.delete(chatId)
      if (buffered.trim()) {
        const mentioned = extractLastFilePath(buffered)
        if (mentioned) runtime.lastMentionedFilePath = mentioned
        await sendText(chatId, buffered)
      }
      break
    }

    case 'error':
      runtime.state = 'idle'
      runtime.verb = undefined
      streamingBuffers.delete(chatId)
      if (msg.message && /Invalid.*signature.*thinking/i.test(msg.message)) {
        const stored = sessionStore.get(chatId)
        const workDir = stored?.workDir || config.wechat.defaultWorkDir || config.defaultProjectDir
        if (workDir) {
          await sendText(chatId, '⚠️ 会话上下文已失效，正在自动重建...')
          clearTransientChatState(chatId)
          bridge.resetSession(chatId)
          sessionStore.delete(chatId)
          const ok = await createSessionForChat(chatId, workDir)
          if (ok) await sendText(chatId, '✅ 已重建会话，请重新发送消息。')
          else await sendText(chatId, '❌ 重建会话失败，请发送 /new 手动新建。')
        } else {
          await sendText(chatId, '⚠️ 会话上下文已失效，请发送 /new 新建会话。')
        }
      } else {
        await sendText(chatId, `❌ ${msg.message}`)
      }
      break

    case 'system_notification':
      if (msg.subtype === 'init' && msg.data && typeof msg.data === 'object') {
        const model = (msg.data as Record<string, unknown>).model
        if (typeof model === 'string' && model.trim()) runtime.model = model
      }
      break
  }
}

// ---------- inbound permission shortcuts ----------

function tryHandlePermissionShortcut(chatId: string, text: string): boolean {
  const runtime = getRuntimeState(chatId)
  const requestId = runtime.lastPermissionRequestId
  if (!requestId) return false
  const trimmed = text.trim().toLowerCase()

  // Always-allow: pin a session rule via the existing rule='always' wire so
  // the same tool stops prompting for the rest of this session.
  if (trimmed === 'ya' || trimmed === '永远' || trimmed === '永远允许' || trimmed === 'always') {
    bridge.sendPermissionResponse(chatId, requestId, true, 'always')
    runtime.pendingPermissionCount = Math.max(0, runtime.pendingPermissionCount - 1)
    runtime.lastPermissionRequestId = undefined
    void sendText(chatId, '✅ 已允许，本会话内此工具不再询问')
    return true
  }

  // Per-turn auto-approve: allow the current request and silently accept
  // every subsequent permission_request until message_complete.
  if (trimmed === 'ys' || trimmed === '本轮' || trimmed === '本轮允许' || trimmed === 'session') {
    bridge.sendPermissionResponse(chatId, requestId, true)
    runtime.permitAllInTurn = true
    runtime.pendingPermissionCount = Math.max(0, runtime.pendingPermissionCount - 1)
    runtime.lastPermissionRequestId = undefined
    void sendText(chatId, '✅ 本轮后续操作将自动允许')
    return true
  }

  if (trimmed === 'y' || trimmed === 'yes' || trimmed === '允许' || trimmed === '1') {
    bridge.sendPermissionResponse(chatId, requestId, true)
    runtime.pendingPermissionCount = Math.max(0, runtime.pendingPermissionCount - 1)
    runtime.lastPermissionRequestId = undefined
    void sendText(chatId, '✅ 已允许')
    return true
  }
  if (trimmed === 'n' || trimmed === 'no' || trimmed === '拒绝' || trimmed === '2') {
    bridge.sendPermissionResponse(chatId, requestId, false)
    runtime.pendingPermissionCount = Math.max(0, runtime.pendingPermissionCount - 1)
    runtime.lastPermissionRequestId = undefined
    void sendText(chatId, '❌ 已拒绝')
    return true
  }
  return false
}

// ---------- file path extraction ----------

/** Match the last absolute filesystem path that looks like a real file
 *  (has an extension) inside a string. Handles Windows backslash paths
 *  ("C:\foo\bar.pptx") and POSIX paths ("/home/user/x.pdf"), trimming
 *  trailing punctuation that often follows path mentions in prose. */
const FILE_PATH_REGEX =
  /([A-Za-z]:\\[^\s"'<>|*?\n\r]+\.[A-Za-z0-9]{1,8}|\/[^\s"'<>|*?\n\r]+\.[A-Za-z0-9]{1,8})/g

function extractLastFilePath(text: string): string | undefined {
  const matches = text.match(FILE_PATH_REGEX)
  if (!matches || matches.length === 0) return undefined
  // Strip trailing closing punctuation that doesn't belong to the path.
  return matches[matches.length - 1]!.replace(/[.,;:)\]}」、]+$/, '')
}

/** Heuristic: did the user ask the bot to deliver a file via natural
 *  language? Catches Chinese ("发给我", "发我", "给我发", "把…发", "发过来",
 *  "传给我") and English ("send (it) to me", "send me"). False positives are
 *  acceptable here — sending an extra file is not destructive — so the
 *  pattern errs on the inclusive side. */
const SEND_TO_ME_REGEX =
  /(?:发(?:给|送|来|过来)?\s*我|给\s*我\s*发|发(?:给|送)\s*过来|传给我|传我|send(?:\s+it)?\s+to\s+me|send\s+me)/i

function looksLikeSendRequest(text: string): boolean {
  return SEND_TO_ME_REGEX.test(text)
}

// ---------- inbound message handler ----------

async function handleInboundMessage(msg: WeixinMessage): Promise<void> {
  const senderId = msg.from_user_id
  const messageId = msg.message_id
  if (!senderId || messageId == null) return
  // Only react to user-originated messages (message_type === 1). The bot's
  // own outgoing echoes show up here too and would otherwise loop.
  if (msg.message_type === 2) return
  if (!dedup.tryRecord(`${messageId}`)) return

  const chatId = senderId
  const runtime = getRuntimeState(chatId)
  if (typeof msg.context_token === 'string' && msg.context_token) {
    runtime.contextToken = msg.context_token
  }

  const payload = extractInboundPayload(msg)
  const msgText = payload.text.trim()
  const hasAttachments = payload.pendingDownloads.length > 0

  if (!isAllowedUser('wechat', chatId)) {
    if (msgText) {
      const success = tryPair(msgText, { userId: chatId, displayName: 'Wechat User' }, 'wechat')
      if (success) {
        await sendText(chatId, '✅ 配对成功！现在可以开始聊天了。\n\n发送消息即可与 Claude 对话。')
      } else {
        await sendText(chatId, '🔒 未授权。请在 Claude Code 桌面端生成配对码后发送给我。')
      }
    }
    return
  }

  if (!msgText && !hasAttachments) return

  if (!hasAttachments && tryHandlePermissionShortcut(chatId, msgText)) return

  enqueue(chatId, async () => {
    if (!hasAttachments && (msgText === '/new' || msgText === '新会话' || msgText.startsWith('/new '))) {
      const arg = msgText.startsWith('/new ') ? msgText.slice(5).trim() : ''
      await startNewSession(chatId, arg || undefined)
      return
    }
    if (!hasAttachments && (msgText === '/help' || msgText === '帮助')) {
      await sendText(chatId, formatImHelp())
      return
    }
    if (!hasAttachments && (msgText === '/status' || msgText === '状态')) {
      await sendText(chatId, await buildStatusText(chatId))
      return
    }
    if (!hasAttachments && (msgText === '/clear' || msgText === '清空')) {
      const stored = await ensureExistingSession(chatId)
      if (!stored) {
        await sendText(chatId, formatImStatus(null))
        return
      }
      clearTransientChatState(chatId)
      const sent = bridge.sendUserMessage(chatId, '/clear')
      if (!sent) {
        await sendText(chatId, '⚠️ 无法发送 /clear，请先发送 /new 重新连接会话。')
        return
      }
      await sendText(chatId, '🧹 已清空当前会话上下文。')
      return
    }
    if (!hasAttachments && (msgText === '/stop' || msgText === '停止')) {
      const stored = await ensureExistingSession(chatId)
      if (!stored) {
        await sendText(chatId, formatImStatus(null))
        return
      }
      bridge.sendStopGeneration(chatId)
      await sendText(chatId, '⏹ 已发送停止信号。')
      return
    }
    if (!hasAttachments && (msgText === '/projects' || msgText === '项目列表')) {
      await showProjectPicker(chatId)
      return
    }

    // /send_file [path] — deliver a local file to the user. Without an
    // explicit path, fall back to the last absolute path the assistant
    // mentioned in this chat. Aliases: /sf, /发送, /发我.
    if (
      !hasAttachments &&
      (msgText === '/send_file' ||
        msgText.startsWith('/send_file ') ||
        msgText === '/sf' ||
        msgText.startsWith('/sf ') ||
        msgText === '/发送' ||
        msgText.startsWith('/发送 ') ||
        msgText === '/发我' ||
        msgText.startsWith('/发我 '))
    ) {
      const space = msgText.indexOf(' ')
      const arg = space >= 0 ? msgText.slice(space + 1).trim() : ''
      const target = arg || getRuntimeState(chatId).lastMentionedFilePath
      if (!target) {
        await sendText(
          chatId,
          '用法: /send_file <文件路径>\n例: /send_file C:\\path\\to\\file.pptx\n\n' +
            '提示: 助手刚才提到的文件路径会自动记忆，下次直接发送 /send_file 即可。',
        )
        return
      }
      await sendFileToUser(chatId, target)
      return
    }

    // Natural-language "send me this file" detection. The user often types
    // "把文件发给我" instead of /send_file, especially in WeChat. If the
    // message both expresses send-intent AND includes (or implies via the
    // last assistant-mentioned path) a target, deliver it directly without
    // routing through the LLM — otherwise the assistant just apologizes
    // for not having file-send tools, which is wrong now.
    if (!hasAttachments && looksLikeSendRequest(msgText)) {
      const inlinePath = extractLastFilePath(msgText)
      const target = inlinePath || getRuntimeState(chatId).lastMentionedFilePath
      if (target) {
        await sendFileToUser(chatId, target)
        return
      }
    }

    if (!hasAttachments && pendingProjectSelection.has(chatId)) {
      await startNewSession(chatId, msgText.trim())
      return
    }

    const ready = await ensureSession(chatId)
    if (!ready) return

    let attachments: AttachmentRef[] | undefined
    if (hasAttachments) {
      const stored = sessionStore.get(chatId)
      const sessionId = stored?.sessionId ?? chatId
      const settled = await Promise.allSettled(
        payload.pendingDownloads.map((p) =>
          media.downloadResource({
            filekey: p.filekey,
            aeskey: p.aeskey,
            cdnUrl: p.cdnUrl,
            kind: p.kind,
            fileName: p.fileName,
            sessionId,
          }),
        ),
      )
      const accepted: AttachmentRef[] = []
      let downloadFailures = 0
      for (const r of settled) {
        if (r.status === 'rejected') {
          downloadFailures += 1
          console.error('[Wechat] downloadResource failed:', r.reason)
          continue
        }
        const local = r.value
        const check = checkAttachmentLimit(local.kind, local.size, local.mimeType)
        if (!check.ok) {
          await sendText(chatId, check.hint)
          continue
        }
        if (local.kind === 'image') {
          accepted.push({
            type: 'image',
            name: local.name,
            data: local.buffer.toString('base64'),
            mimeType: local.mimeType,
          })
        } else {
          accepted.push({
            type: 'file',
            name: local.name,
            path: local.path,
            mimeType: local.mimeType,
          })
        }
      }
      if (downloadFailures > 0) {
        await sendText(
          chatId,
          downloadFailures === payload.pendingDownloads.length
            ? '📎 附件下载失败,请稍后重试'
            : `📎 ${downloadFailures} 个附件下载失败,已跳过`,
        )
      }
      if (accepted.length > 0) attachments = accepted
    }

    const effective = msgText || (attachments && attachments.length > 0 ? '(用户发送了附件)' : '')
    if (!effective && !(attachments && attachments.length > 0)) return

    const sent = bridge.sendUserMessage(chatId, effective, attachments)
    if (!sent) {
      await sendText(chatId, '⚠️ 消息发送失败，连接可能已断开。请发送 /new 重新开始。')
    }
  })
}

// ---------- long-poll loop ----------

function enterTokenExpiredPause(): void {
  pauseUntil = Date.now() + TOKEN_EXPIRED_PAUSE_MS
  console.error(
    `[Wechat] Token expired (errcode=${WX_ERR_TOKEN_EXPIRED}). Pausing long-poll for ${TOKEN_EXPIRED_PAUSE_MS / 60_000} min. Re-run wechat:login after the pause if the issue persists.`,
  )
}

async function pollLoop(): Promise<void> {
  let timeoutMs = config.wechat.longPollTimeoutMs
  let cursor = loadSyncCursor(account.accountId)

  while (!stopped) {
    if (pauseUntil > Date.now()) {
      const wait = Math.min(60_000, pauseUntil - Date.now())
      await new Promise((r) => setTimeout(r, wait))
      continue
    }
    try {
      const resp = await client.getUpdates(cursor, timeoutMs)
      // Tencent's getUpdates only returns `ret` / `errcode` on error. A
      // successful long-poll response has neither field — just msgs and
      // get_updates_buf. So treat null/undefined ret as success; only the
      // explicit non-zero values are protocol failures.
      if (resp.ret != null && resp.ret !== 0) {
        if (resp.errcode === WX_ERR_TOKEN_EXPIRED) {
          enterTokenExpiredPause()
          continue
        }
        console.error(`[Wechat] getUpdates ret=${resp.ret} errcode=${resp.errcode} ${resp.errmsg ?? ''}`)
        await new Promise((r) => setTimeout(r, 5_000))
        continue
      }
      if (typeof resp.get_updates_buf === 'string' && resp.get_updates_buf !== cursor) {
        cursor = resp.get_updates_buf
        saveSyncCursor(account.accountId, cursor)
      }
      if (typeof resp.longpolling_timeout_ms === 'number' && resp.longpolling_timeout_ms > 0) {
        timeoutMs = resp.longpolling_timeout_ms
      }
      if (resp.msgs && resp.msgs.length > 0) {
        for (const m of resp.msgs) {
          handleInboundMessage(m).catch((err) => {
            console.error('[Wechat] handleInboundMessage error:', err)
          })
        }
      }
    } catch (err) {
      // AbortError on long-poll is normal at the timeout boundary; brief backoff
      // on other transport failures so we don't hot-loop the upstream.
      const message = err instanceof Error ? err.message : String(err)
      if (!/abort/i.test(message)) {
        console.error('[Wechat] poll error:', message)
        await new Promise((r) => setTimeout(r, 3_000))
      }
    }
  }
}

// ---------- start ----------

async function start(): Promise<void> {
  console.log('[Wechat] Starting bot...')
  console.log(`[Wechat] Server: ${config.serverUrl}`)
  console.log(`[Wechat] Account: ${account.accountId} (baseUrl=${account.baseUrl})`)
  console.log(`[Wechat] Endpoints: ${WX_ENDPOINTS.getUpdates}, ${WX_ENDPOINTS.sendMessage}`)
  console.log(`[Wechat] Allowed users: ${config.wechat.allowedUsers.length === 0 ? '(use pairing)' : config.wechat.allowedUsers.join(', ')}`)
  pollLoop().catch((err) => {
    console.error('[Wechat] poll loop crashed:', err)
    process.exit(1)
  })
  console.log('[Wechat] Bot is running!')
}

start().catch((err) => {
  console.error('[Wechat] Failed to start:', err)
  process.exit(1)
})

process.on('SIGINT', () => {
  console.log('[Wechat] Shutting down...')
  stopped = true
  bridge.destroy()
  dedup.destroy()
  process.exit(0)
})
