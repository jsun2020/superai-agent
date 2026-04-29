/**
 * 消息格式化工具
 */

type AdapterChatState =
  | 'idle'
  | 'thinking'
  | 'streaming'
  | 'tool_executing'
  | 'permission_pending'

type ImStatusSummary = {
  sessionId?: string
  projectName?: string | null
  branch?: string | null
  model?: string | null
  state?: AdapterChatState | null
  verb?: string | null
  pendingPermissionCount?: number
  taskCounts?: {
    total: number
    pending: number
    inProgress: number
    completed: number
  }
}

const IM_HELP_LINES = [
  '/new [项目] — 新建会话或切换项目',
  '/projects — 查看最近项目',
  '/status — 查看当前会话状态',
  '/clear — 清空当前会话上下文',
  '/stop — 停止当前生成',
  '/send_file [路径] — 发送本地文件到当前聊天 (亦可说 "把xxx发给我")',
  '/help — 显示这份帮助',
  '',
  '权限确认: y 允许 / n 拒绝 / ya 始终允许该工具 / ys 本轮全部允许',
]

/** Split text into chunks that fit within a character limit, respecting paragraph/sentence boundaries. */
export function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining)
      break
    }

    let splitAt = remaining.lastIndexOf('\n\n', limit)
    if (splitAt <= 0) splitAt = remaining.lastIndexOf('\n', limit)
    if (splitAt <= 0) splitAt = remaining.lastIndexOf('. ', limit)
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', limit)
    if (splitAt <= 0) splitAt = limit

    // Include the delimiter for paragraph/sentence breaks
    if (remaining[splitAt] === '\n' || remaining[splitAt] === '.') splitAt += 1

    chunks.push(remaining.slice(0, splitAt).trimEnd())
    remaining = remaining.slice(splitAt).trimStart()
  }

  return chunks
}

/** Format tool use info for display in IM. */
export function formatToolUse(toolName: string, input: unknown): string {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const summary = formatToolSummary(toolName, inp)
  if (summary) return `🔧 ${toolName}  ${summary}`
  const preview = truncateInput(input, 200)
  return `🔧 ${toolName}\n${preview}`
}

/** Generate a concise human-readable summary for common tools. */
function formatToolSummary(tool: string, inp: Record<string, unknown>): string | null {
  switch (tool) {
    case 'Bash': {
      const desc = inp.description as string | undefined
      const cmd = inp.command as string | undefined
      if (desc) return desc
      if (cmd) return truncate(cmd, 120)
      return null
    }
    case 'Read': {
      const fp = inp.file_path as string | undefined
      if (fp) return shortPath(fp)
      return null
    }
    case 'Edit': {
      const fp = inp.file_path as string | undefined
      if (fp) return shortPath(fp)
      return null
    }
    case 'Write': {
      const fp = inp.file_path as string | undefined
      if (fp) return shortPath(fp)
      return null
    }
    case 'Grep': {
      const pat = inp.pattern as string | undefined
      const p = inp.path as string | undefined
      if (pat) return `"${truncate(pat, 60)}"` + (p ? ` in ${shortPath(p)}` : '')
      return null
    }
    case 'Glob': {
      const pat = inp.pattern as string | undefined
      return pat ? `"${pat}"` : null
    }
    case 'Skill': {
      const skill = inp.skill as string | undefined
      return skill || null
    }
    case 'Agent': {
      const desc = inp.description as string | undefined
      return desc || null
    }
    case 'WebFetch': {
      const url = inp.url as string | undefined
      return url ? truncate(url, 120) : null
    }
    case 'WebSearch': {
      const q = inp.query as string | undefined
      return q ? `"${truncate(q, 80)}"` : null
    }
    default:
      return null
  }
}

function shortPath(fp: string): string {
  const parts = fp.split('/')
  return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : fp
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** Format a permission request for display in IM. */
export function formatPermissionRequest(toolName: string, input: unknown, requestId: string): string {
  const preview = truncateInput(input, 300)
  return `🔐 需要权限确认 [${requestId}]\n工具: ${toolName}\n${preview}`
}

/** Subset of `ComputerUsePermissionRequest` (src/server/ws/events.ts) that the
 *  IM adapters actually care about. Keep in sync if the server-side type grows
 *  new fields the user must approve. */
export type CuRequestForIm = {
  requestId: string
  reason?: string
  apps?: Array<{
    requestedName?: string
    resolved?: { bundleId?: string; displayName?: string }
    isSentinel?: boolean
    alreadyGranted?: boolean
    proposedTier?: 'read' | 'click' | 'full'
  }>
  requestedFlags?: {
    clipboardRead?: boolean
    clipboardWrite?: boolean
    systemKeyCombos?: boolean
  }
  willHide?: Array<{ bundleId?: string; displayName?: string }>
}

/** Render a Computer Use permission request as a Chinese plain-text prompt
 *  suitable for WeChat / Telegram (and as the body for Feishu's card view).
 *  Lists the apps the model wants to drive plus any extra capabilities
 *  (clipboard, system key combos). */
export function formatComputerUsePermissionRequest(
  request: CuRequestForIm,
): string {
  const lines: string[] = []
  lines.push(`🖥️ 需要 Computer Use 授权 [${request.requestId}]`)
  if (request.reason && request.reason.trim()) {
    lines.push(`原因: ${truncate(request.reason.trim(), 200)}`)
  }
  const apps = request.apps ?? []
  if (apps.length > 0) {
    lines.push('请求控制以下应用:')
    for (const app of apps) {
      const name =
        app.resolved?.displayName ||
        app.requestedName ||
        app.resolved?.bundleId ||
        '(未知应用)'
      const tierLabel = app.proposedTier
        ? { read: '只读', click: '点击', full: '完全控制' }[app.proposedTier]
        : ''
      const installed = app.resolved ? '' : ' ⚠️ 未安装'
      const already = app.alreadyGranted ? ' ✅ 已授权' : ''
      const tier = tierLabel ? ` · ${tierLabel}` : ''
      lines.push(`  • ${name}${tier}${installed}${already}`)
    }
  }
  const flags = request.requestedFlags ?? {}
  const flagLabels: string[] = []
  if (flags.clipboardRead) flagLabels.push('读取剪贴板')
  if (flags.clipboardWrite) flagLabels.push('写入剪贴板')
  if (flags.systemKeyCombos) flagLabels.push('系统快捷键')
  if (flagLabels.length > 0) {
    lines.push(`额外权限: ${flagLabels.join('、')}`)
  }
  const willHide = request.willHide ?? []
  if (willHide.length > 0) {
    const names = willHide
      .map((w) => w.displayName || w.bundleId || '?')
      .join('、')
    lines.push(`执行期间将隐藏: ${names}`)
  }
  return lines.join('\n')
}

/** Build a `ComputerUsePermissionResponse` payload that grants every app the
 *  request mentioned (mirrors `buildAllowResponse` in the desktop modal at
 *  desktop/src/components/chat/ComputerUsePermissionModal.tsx). Apps that
 *  failed to resolve become `denied: not_installed`. Requested flags are
 *  passed through verbatim so the model gets exactly the capabilities it
 *  asked for. */
export function buildComputerUseAllowResponse(
  request: CuRequestForIm,
): Record<string, unknown> {
  const now = Date.now()
  const granted: Array<Record<string, unknown>> = []
  const denied: Array<Record<string, unknown>> = []
  for (const app of request.apps ?? []) {
    if (app.resolved && !app.alreadyGranted) {
      granted.push({
        bundleId: app.resolved.bundleId,
        displayName: app.resolved.displayName,
        grantedAt: now,
        tier: app.proposedTier,
      })
    } else if (!app.resolved) {
      denied.push({
        bundleId: app.requestedName,
        reason: 'not_installed',
      })
    }
  }
  const flags = {
    clipboardRead: request.requestedFlags?.clipboardRead === true,
    clipboardWrite: request.requestedFlags?.clipboardWrite === true,
    systemKeyCombos: request.requestedFlags?.systemKeyCombos === true,
  }
  return {
    granted,
    denied,
    flags,
    userConsented: true,
  }
}

/** Build a `ComputerUsePermissionResponse` payload that denies the request. */
export function buildComputerUseDenyResponse(): Record<string, unknown> {
  return {
    granted: [],
    denied: [],
    flags: {
      clipboardRead: false,
      clipboardWrite: false,
      systemKeyCombos: false,
    },
    userConsented: false,
  }
}

/** Inline hint listing every shortcut accepted by the WeChat permission
 *  handler. Kept centralised so the prompt and /help stay in sync. */
export const WECHAT_PERMISSION_HINT =
  '回复 `y` 允许一次，`n` 拒绝；`ya` 始终允许该工具；`ys` 本轮全部允许。'

/** One-time guidance prepended to the first user message of a fresh IM
 *  session, telling the model how to deliver files back through the IM
 *  channel. The IM adapters watch the assistant's streaming text for
 *  markdown image references (![](...)) and auto-upload the referenced
 *  file — but the model has no way to know this convention exists, so
 *  without this hint it tends to give up with "I can't send files."
 *
 *  Kept compact: a single fenced "context" block that's clearly an
 *  out-of-band system note rather than user content. */
export const IM_FILE_DELIVERY_HINT =
  [
    '[IM context — read once, do not echo]',
    'You are talking to the user over an IM channel (WeChat / Feishu / Telegram).',
    'To deliver an image or file to the user, embed it in your reply as a markdown image:',
    '  ![brief description](ABSOLUTE_PATH)',
    'Examples that work:',
    '  ![screenshot](C:/Users/me/AppData/Local/Temp/claude/foo.png)',
    '  ![screenshot](/tmp/foo.png)',
    '  ![screenshot](file:///C:/Users/me/foo.png)',
    'The IM adapter watches your output stream for these and uploads the file',
    'to the chat automatically. Use absolute paths only (no %TEMP% etc.).',
    'For non-image files, tell the user the absolute path and they can reply',
    '"/send_file" or "把文件发给我" to receive it.',
  ].join('\n')

/** Wrap a user-typed message so the model receives the IM-delivery hint
 *  ahead of it, while still treating the user's text as the actual prompt. */
export function prependImFileDeliveryHint(userText: string): string {
  return `${IM_FILE_DELIVERY_HINT}\n\n---\n\n${userText}`
}

/** Truncate tool input to a preview string. */
export function truncateInput(input: unknown, maxLen: number): string {
  try {
    const s = typeof input === 'string' ? input : JSON.stringify(input, null, 2)
    return s.length > maxLen ? s.slice(0, maxLen) + '…' : s
  } catch {
    return '(unserializable)'
  }
}

/** Escape special characters for Telegram MarkdownV2. */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
}

export function formatImHelp(): string {
  return `可用命令：\n\n${IM_HELP_LINES.join('\n')}`
}

export function formatImStatus(summary: ImStatusSummary | null): string {
  if (!summary?.sessionId) {
    return '当前没有活动会话。\n\n发送 /new 新建会话，或发送 /projects 选择项目。'
  }

  const lines = ['当前会话状态：']

  if (summary.projectName) {
    lines.push(`项目: ${summary.projectName}${summary.branch ? ` (${summary.branch})` : ''}`)
  } else if (summary.branch) {
    lines.push(`分支: ${summary.branch}`)
  }

  lines.push(`会话: ${shortSessionId(summary.sessionId)}`)

  if (summary.model) {
    lines.push(`模型: ${summary.model}`)
  }

  lines.push(`状态: ${formatAdapterChatState(summary.state, summary.verb)}`)

  const pendingPermissionCount = summary.pendingPermissionCount ?? 0
  if (pendingPermissionCount > 0) {
    lines.push(`审批: ${pendingPermissionCount} 个待确认`)
  }

  const taskCounts = summary.taskCounts
  if (taskCounts && taskCounts.total > 0) {
    const taskParts = [`总计 ${taskCounts.total}`]
    if (taskCounts.inProgress > 0) taskParts.push(`进行中 ${taskCounts.inProgress}`)
    if (taskCounts.pending > 0) taskParts.push(`待处理 ${taskCounts.pending}`)
    if (taskCounts.completed > 0) taskParts.push(`已完成 ${taskCounts.completed}`)
    lines.push(`任务: ${taskParts.join(' · ')}`)
  }

  return lines.join('\n')
}

function formatAdapterChatState(
  state: AdapterChatState | null | undefined,
  verb: string | null | undefined,
): string {
  const label = (() => {
    switch (state) {
      case 'thinking':
        return '思考中'
      case 'streaming':
        return '生成中'
      case 'tool_executing':
        return '执行工具中'
      case 'permission_pending':
        return '等待权限确认'
      case 'idle':
      default:
        return '空闲'
    }
  })()

  if (!verb || verb === 'Thinking') return label
  return `${label} (${verb})`
}

function shortSessionId(sessionId: string): string {
  return sessionId.length > 12 ? `${sessionId.slice(0, 8)}…` : sessionId
}
