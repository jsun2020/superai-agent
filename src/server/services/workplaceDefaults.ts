/**
 * Built-in workplace catalog: the Work-mode prompt, the three shipped roles,
 * the connector catalog and the outbound-verb list.
 *
 * Two jobs:
 *   1. Seed material for ~/.superai on first run (see superaiHome.ts).
 *   2. Fallback when a file is missing or unreadable, so a damaged folder can
 *      never take a role or connector away — only a deliberate `disabled: true`
 *      or a deleted file can.
 *
 * Text is bilingual here rather than in the desktop's locale tables because
 * a user-authored role has no locale table: the file IS the source of every
 * language it supports. Shipping ours the same way means the built-ins are
 * not special.
 *
 * ASCII-only in prompt bodies: they are passed as a CLI argument. Bun's spawn
 * round-trips UTF-8 argv on Windows (probed 2026-08-17), so user files may use
 * any script — the ASCII rule is kept for the shipped seeds only because it is
 * the more conservative choice for text we cannot see the machine of.
 */

import type { LocalizedText } from './localized.js'

// ─── Work-mode base prompt ──────────────────────────────────────────────────

export const BUILT_IN_WORK_MODE_PROMPT = `SuperAI Agent is running in Work mode, made for general office users rather than developers.
- Assume the user is not a programmer: explain in plain language, avoid jargon, and do not show code unless they ask. Present results as files, tables, and short summaries.
- For any task involving office documents or media - PowerPoint (.pptx), Excel (.xlsx/.csv), Word (.docx), PDF, images, or video - delegate to the 'office' subagent via the Agent tool instead of doing it inline; it knows the preferred document toolchain.
- Typical Work-mode requests: building or editing slide decks, analyzing spreadsheets, filling contract/form/invoice templates, converting documents, organizing and renaming files, and summarizing reports.
- Never modify the user's original files in place; write output to a new file (or a backup copy first) and always report the absolute path of every file you produce.
- Verify deliverables before reporting done (reopen the file, check page/slide/sheet counts).
- Coding questions are still fine to answer, but do not assume a software project context - no repos, builds, or test suites unless the user brings them up.`

// ─── Roles ──────────────────────────────────────────────────────────────────

export type WorkRoleDefinition = {
  /** Lowercase letters, digits, dashes. Doubles as the filename. */
  id: string
  /** Material Symbols icon name. */
  icon: string
  name: LocalizedText
  tagline: LocalizedText
  worksWith: LocalizedText
  /** Example prompts shown once the role is picked. */
  examples: LocalizedText[]
  /** Appended after the Work-mode prompt when this role is picked. */
  prompt: string
  disabled?: boolean
}

export const BUILT_IN_ROLES: readonly WorkRoleDefinition[] = [
  {
    id: 'assistant',
    icon: 'event_available',
    name: { en: 'Assistant', zh: '助理' },
    tagline: {
      en: 'Triages the inbox, owns the calendar, and keeps your day on rails.',
      zh: '整理收件箱、打理日程，让你的一天井井有条。',
    },
    worksWith: { en: 'Email · Calendar · Meeting notes', zh: '邮件 · 日历 · 会议纪要' },
    examples: [
      {
        en: 'Triage my inbox and draft replies to anything urgent',
        zh: '整理我的收件箱，并为紧急邮件起草回复',
      },
      {
        en: 'Turn these meeting notes into action items with owners',
        zh: '把这份会议纪要整理成带负责人的待办事项',
      },
    ],
    prompt: `The user has chosen the Assistant role. Their work centres on their inbox, calendar, and meetings.
- Delegate this work to the 'assistant' subagent via the Agent tool; it knows the triage, drafting and meeting-prep conventions.
- Draft, never send. Before any outbound message or calendar change, show the exact content and recipients and wait for an explicit yes.`,
  },
  {
    id: 'sales',
    icon: 'trending_up',
    name: { en: 'Sales', zh: '销售' },
    tagline: {
      en: 'Researches accounts, preps every meeting, drafts follow-ups that sound like you.',
      zh: '调研客户、准备每一场会议，起草像你本人写的跟进邮件。',
    },
    worksWith: { en: 'CRM · Email · Account research', zh: 'CRM · 邮件 · 客户调研' },
    examples: [
      {
        en: 'Research this account and build a one-page meeting brief',
        zh: '调研这家客户，做一页会前简报',
      },
      {
        en: 'Draft a follow-up email from these call notes',
        zh: '根据这份通话记录起草一封跟进邮件',
      },
    ],
    prompt: `The user has chosen the Sales role. Their work centres on accounts, prospects, deals, and CRM records.
- Delegate this work to the 'sales' subagent via the Agent tool; it knows the research, follow-up and CRM conventions.
- Never invent a price, discount, delivery date or commitment. Anything not present in a source the user gave you is [TBD - confirm], and outbound messages are drafted for approval, never sent.`,
  },
  {
    id: 'analyst',
    icon: 'insights',
    name: { en: 'Analyst', zh: '分析师' },
    tagline: {
      en: 'Turns spreadsheets into a finding, and repeats it the same way every week.',
      zh: '把表格变成结论，并且每周都用同样的方式呈现。',
    },
    worksWith: { en: 'Excel · CSV · Reports', zh: 'Excel · CSV · 报表' },
    examples: [
      {
        en: 'Analyze this spreadsheet and tell me what changed',
        zh: '分析这份表格，告诉我发生了什么变化',
      },
      {
        en: 'Build a weekly report from this data with charts',
        zh: '用这些数据做一份带图表的周报',
      },
    ],
    prompt: `The user has chosen the Analyst role. Their work centres on turning spreadsheets and exported data into reports and decisions.
- Delegate this work to the 'analyst' subagent via the Agent tool; it knows the reporting and data-hygiene conventions.
- Lead with the finding, state the data source and the period covered, report any rows dropped, and never write over the user's raw data.`,
  },
]

/**
 * Serialize a role to the on-disk markdown format: YAML frontmatter with
 * `<field>` for English and `<field>_<locale>` for every other locale, then
 * the prompt as the body. This is the format the README documents and the
 * loader parses; keeping the writer next to the data means the seeds are
 * guaranteed to round-trip.
 */
export function serializeRoleFile(role: WorkRoleDefinition): string {
  const lines: string[] = ['---']

  const scalar = (key: string, text: LocalizedText) => {
    if (typeof text === 'string') {
      lines.push(`${key}: ${yamlString(text)}`)
      return
    }
    for (const [locale, value] of Object.entries(text)) {
      if (value === undefined) continue
      lines.push(`${locale === 'en' ? key : `${key}_${locale}`}: ${yamlString(value)}`)
    }
  }

  scalar('name', role.name)
  lines.push(`icon: ${role.icon}`)
  scalar('tagline', role.tagline)
  scalar('worksWith', role.worksWith)

  // examples: group by locale so each list is contiguous.
  const byLocale = new Map<string, string[]>()
  for (const example of role.examples) {
    if (typeof example === 'string') {
      byLocale.set('en', [...(byLocale.get('en') ?? []), example])
      continue
    }
    for (const [locale, value] of Object.entries(example)) {
      if (value === undefined) continue
      byLocale.set(locale, [...(byLocale.get(locale) ?? []), value])
    }
  }
  for (const [locale, values] of byLocale) {
    lines.push(locale === 'en' ? 'examples:' : `examples_${locale}:`)
    for (const value of values) lines.push(`  - ${yamlString(value)}`)
  }

  if (role.disabled) lines.push('disabled: true')
  lines.push('---')
  return `${lines.join('\n')}\n${role.prompt}\n`
}

/** Quote a YAML scalar only when it needs it; keeps the seeds readable. */
function yamlString(value: string): string {
  const safe = /^[A-Za-z0-9一-鿿][^#:\n"'{}\[\],&*!|>%@`]*$/.test(value)
  return safe ? value : JSON.stringify(value)
}

// ─── Connectors ─────────────────────────────────────────────────────────────

export type ConnectorFieldDefinition =
  | {
      key: string
      type: 'text' | 'password'
      label: LocalizedText
      required?: boolean
      placeholder?: string
      hint?: LocalizedText
    }
  | {
      key: string
      type: 'select'
      label: LocalizedText
      defaultValue: string
      options: ReadonlyArray<{ value: string; label: LocalizedText }>
      hint?: LocalizedText
    }
  | {
      key: string
      type: 'checkbox'
      label: LocalizedText
      defaultValue: boolean
      hint?: LocalizedText
    }

/**
 * One entry of a config template's `args`. Strings get `{{key}}` substituted;
 * the object forms add their `then` list conditionally.
 */
export type ArgTemplate =
  | string
  | { if: string; then: string[] }
  | { unless: string; then: string[] }

export type ConnectorConfigTemplate =
  | {
      type: 'stdio'
      command: string
      args: ArgTemplate[]
      env?: Record<string, string>
    }
  | {
      type: 'http' | 'sse'
      url: string
      headers?: Record<string, string>
    }

export type ConnectorDefinition = {
  id: string
  /** Default MCP server name; the user can rename before connecting. */
  serverName: string
  icon: string
  name: LocalizedText
  description: LocalizedText
  worksWith: LocalizedText
  /**
   * Who maintains the server. Surfaced in the UI because the user is about to
   * hand it a mailbox or a chat workspace — "official" vs "community" is
   * information they are entitled to before that, not a detail.
   */
  provenance: 'official' | 'community'
  packageName?: string
  docsUrl?: string
  status: 'available' | 'coming-soon'
  fields: readonly ConnectorFieldDefinition[]
  /** Warning shown in the connect form (e.g. secrets stored in plain text). */
  securityNote?: LocalizedText
  /** Shown after a successful connect (e.g. "now run the login step"). */
  postConnectHint?: LocalizedText
  /** Absent for coming-soon entries. */
  config?: ConnectorConfigTemplate
  disabled?: boolean
}

/**
 * Package names and flags are copied from each vendor's own docs, not
 * inferred — a wrong flag produces a server that starts and silently does
 * nothing (see LL-027).
 */
export const BUILT_IN_CONNECTORS: readonly ConnectorDefinition[] = [
  {
    id: 'feishu',
    serverName: 'lark-mcp',
    icon: 'forum',
    name: { en: 'Feishu / Lark', zh: '飞书 / Lark' },
    description: {
      en: 'Read and write Feishu docs, sheets, messages and calendar through the official OpenAPI server.',
      zh: '通过官方 OpenAPI 服务读写飞书文档、表格、消息和日历。',
    },
    worksWith: { en: 'Docs · Sheets · Messages · Calendar', zh: '文档 · 表格 · 消息 · 日历' },
    provenance: 'official',
    packageName: '@larksuiteoapi/lark-mcp',
    docsUrl: 'https://github.com/larksuite/lark-openapi-mcp',
    status: 'available',
    securityNote: {
      en: 'The App Secret is passed to the server on its command line and stored in plain text in your MCP config — this is the only method the vendor documents. Use an app scoped to just the permissions you need.',
      zh: 'App Secret 会作为命令行参数传给该服务，并以明文保存在 MCP 配置中——这是厂商文档中唯一的方式。建议只授予应用所需的最小权限。',
    },
    fields: [
      {
        key: 'appId',
        type: 'text',
        label: { en: 'App ID', zh: 'App ID' },
        required: true,
        placeholder: 'cli_xxxxxxxxxxxxxxxx',
      },
      {
        key: 'appSecret',
        type: 'password',
        label: { en: 'App Secret', zh: 'App Secret' },
        required: true,
      },
      {
        key: 'domain',
        type: 'select',
        label: { en: 'Platform', zh: '平台' },
        // Empty = the package default, which is Feishu (open.feishu.cn).
        defaultValue: '',
        options: [
          {
            value: '',
            label: { en: 'Feishu (China, open.feishu.cn)', zh: '飞书（中国版，open.feishu.cn）' },
          },
          {
            value: 'https://open.larksuite.com',
            label: {
              en: 'Lark (international, open.larksuite.com)',
              zh: 'Lark（国际版，open.larksuite.com）',
            },
          },
        ],
      },
    ],
    config: {
      type: 'stdio',
      command: 'npx',
      args: [
        '-y',
        '@larksuiteoapi/lark-mcp',
        'mcp',
        '-a',
        '{{appId}}',
        '-s',
        '{{appSecret}}',
        { if: 'domain', then: ['--domain', '{{domain}}'] },
      ],
      env: {},
    },
  },
  {
    id: 'microsoft365',
    serverName: 'ms-365',
    icon: 'mail',
    name: { en: 'Microsoft 365', zh: 'Microsoft 365' },
    description: {
      en: 'Outlook mail and calendar via Microsoft Graph. Signs in with a device code, so no password or secret is stored here.',
      zh: '通过 Microsoft Graph 访问 Outlook 邮件和日历。使用设备码登录，本地不保存密码或密钥。',
    },
    worksWith: { en: 'Outlook mail · Calendar', zh: 'Outlook 邮件 · 日历' },
    provenance: 'community',
    packageName: '@softeria/ms-365-mcp-server',
    docsUrl: 'https://github.com/softeria/ms-365-mcp-server',
    status: 'available',
    postConnectHint: {
      en: 'Almost done — ask the agent to run the Microsoft sign-in, then approve the device code in your browser.',
      zh: '还差一步——让助手执行 Microsoft 登录，然后在浏览器中确认设备码。',
    },
    fields: [
      {
        key: 'readOnly',
        type: 'checkbox',
        label: { en: 'Read-only (recommended)', zh: '只读（推荐）' },
        // Default ON: the agent reads mail and calendar and shows you drafts,
        // but cannot send or move anything. Matches the Work-mode promise.
        defaultValue: true,
        hint: {
          en: 'The agent can read mail and calendar and show you drafts, but cannot send, delete or move anything.',
          zh: '助手可以读取邮件和日历并给你看草稿，但不能发送、删除或移动任何内容。',
        },
      },
      {
        key: 'orgMode',
        type: 'checkbox',
        label: { en: 'Work or school account', zh: '企业或学校账号' },
        defaultValue: false,
        hint: {
          en: 'Enable for a company Microsoft 365 account rather than a personal Outlook account.',
          zh: '如果使用的是公司 Microsoft 365 账号（而非个人 Outlook 账号），请勾选。',
        },
      },
    ],
    // No credentials here by design: this server uses a device-code login, so
    // nothing secret is written into the MCP config file.
    config: {
      type: 'stdio',
      command: 'npx',
      args: [
        '-y',
        '@softeria/ms-365-mcp-server',
        '--preset',
        'mail,calendar',
        { if: 'readOnly', then: ['--read-only'] },
        { if: 'orgMode', then: ['--org-mode'] },
      ],
      env: {},
    },
  },
  {
    id: 'slack',
    serverName: 'slack',
    icon: 'tag',
    name: { en: 'Slack', zh: 'Slack' },
    description: {
      en: 'Read channels and threads, and draft replies for your approval.',
      zh: '读取频道和话题，并起草回复交给你确认。',
    },
    worksWith: { en: 'Channels · Threads · DMs', zh: '频道 · 话题 · 私信' },
    provenance: 'community',
    status: 'coming-soon',
    fields: [],
  },
  {
    id: 'notion',
    serverName: 'notion',
    icon: 'description',
    name: { en: 'Notion', zh: 'Notion' },
    description: {
      en: 'Search and update Notion pages and databases.',
      zh: '搜索并更新 Notion 页面和数据库。',
    },
    worksWith: { en: 'Pages · Databases', zh: '页面 · 数据库' },
    provenance: 'official',
    status: 'coming-soon',
    fields: [],
  },
  {
    id: 'google-workspace',
    serverName: 'google-workspace',
    icon: 'event',
    name: { en: 'Google Workspace', zh: 'Google Workspace' },
    description: {
      en: 'Gmail and Google Calendar for meeting prep and inbox triage.',
      zh: 'Gmail 与 Google 日历，用于会前准备和收件箱整理。',
    },
    worksWith: { en: 'Gmail · Calendar · Drive', zh: 'Gmail · 日历 · 云端硬盘' },
    provenance: 'community',
    status: 'coming-soon',
    fields: [],
  },
  {
    id: 'hubspot',
    serverName: 'hubspot',
    icon: 'contacts',
    name: { en: 'HubSpot', zh: 'HubSpot' },
    description: {
      en: 'Look up accounts and deals, and draft CRM notes for your approval.',
      zh: '查询客户与商机，并起草 CRM 记录交给你确认。',
    },
    worksWith: { en: 'Contacts · Deals · Notes', zh: '联系人 · 商机 · 记录' },
    provenance: 'official',
    status: 'coming-soon',
    fields: [],
  },
]

// ─── Outbound verbs ─────────────────────────────────────────────────────────

/**
 * Tool names that mean "this changes something outside the user's machine".
 *
 * Matched as a segment so a read like `im_v1_message_list` or
 * `docx_v1_document_get` does not trip it, while both vendor naming styles do:
 * Feishu puts the verb last (`im_v1_message_create`), Microsoft 365 puts it
 * first (`send-mail`).
 *
 * Biased toward over-matching on purpose: a needless prompt is an annoyance,
 * a missed one sends mail on the user's behalf.
 */
export const BUILT_IN_OUTBOUND_VERBS: readonly string[] = [
  'create',
  'send',
  'post',
  'update',
  'patch',
  'delete',
  'remove',
  'reply',
  'forward',
  'invite',
  'publish',
  'move',
  'archive',
  'write',
  'share',
  'upload',
]
