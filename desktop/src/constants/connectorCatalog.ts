import type { TranslationKey } from '../i18n'
import type { McpEditableConfig } from '../types/mcp'

/**
 * Curated MCP connector catalog.
 *
 * Our MCP settings form is a raw stdio/http editor — correct, but unusable by
 * the office audience Work mode is for. These entries turn "connect Feishu"
 * into a name, a couple of fields, and a button, then hand the result to the
 * SAME mcpStore.createServer path a hand-written entry uses. No new backend.
 *
 * Package names and flags here are copied from each vendor's own docs, not
 * inferred — a wrong flag produces a server that starts and silently does
 * nothing (see LL-027).
 */

export type ConnectorFieldValue = string | boolean

export type ConnectorField =
  | {
      key: string
      type: 'text' | 'password'
      labelKey: TranslationKey
      required?: boolean
      placeholder?: string
      hintKey?: TranslationKey
    }
  | {
      key: string
      type: 'select'
      labelKey: TranslationKey
      defaultValue: string
      options: ReadonlyArray<{ value: string; labelKey: TranslationKey }>
      hintKey?: TranslationKey
    }
  | {
      key: string
      type: 'checkbox'
      labelKey: TranslationKey
      defaultValue: boolean
      hintKey?: TranslationKey
    }

export type ConnectorDefinition = {
  id: string
  /** Default MCP server name; the user can rename before connecting. */
  serverName: string
  icon: string
  nameKey: TranslationKey
  descriptionKey: TranslationKey
  worksWithKey: TranslationKey
  /**
   * Who maintains the server. Surfaced in the UI because the user is about to
   * hand it a mailbox or a chat workspace — "official" vs "community" is
   * information they are entitled to before that, not a detail.
   */
  provenance: 'official' | 'community'
  packageName?: string
  docsUrl?: string
  status: 'available' | 'coming-soon'
  fields: readonly ConnectorField[]
  /** Warning shown in the connect form (e.g. secrets stored in plain text). */
  securityNoteKey?: TranslationKey
  /** Shown after a successful connect (e.g. "now run the login step"). */
  postConnectHintKey?: TranslationKey
  buildConfig?: (values: Record<string, ConnectorFieldValue>) => McpEditableConfig
}

const str = (values: Record<string, ConnectorFieldValue>, key: string): string => {
  const value = values[key]
  return typeof value === 'string' ? value.trim() : ''
}

export const CONNECTOR_CATALOG: readonly ConnectorDefinition[] = [
  {
    id: 'feishu',
    serverName: 'lark-mcp',
    icon: 'forum',
    nameKey: 'connector.feishu.name',
    descriptionKey: 'connector.feishu.description',
    worksWithKey: 'connector.feishu.worksWith',
    provenance: 'official',
    packageName: '@larksuiteoapi/lark-mcp',
    docsUrl: 'https://github.com/larksuite/lark-openapi-mcp',
    status: 'available',
    securityNoteKey: 'connector.feishu.securityNote',
    fields: [
      {
        key: 'appId',
        type: 'text',
        labelKey: 'connector.feishu.appId',
        required: true,
        placeholder: 'cli_xxxxxxxxxxxxxxxx',
      },
      {
        key: 'appSecret',
        type: 'password',
        labelKey: 'connector.feishu.appSecret',
        required: true,
      },
      {
        key: 'domain',
        type: 'select',
        labelKey: 'connector.feishu.domain',
        // Empty = the package default, which is Feishu (open.feishu.cn).
        defaultValue: '',
        options: [
          { value: '', labelKey: 'connector.feishu.domainFeishu' },
          { value: 'https://open.larksuite.com', labelKey: 'connector.feishu.domainLark' },
        ],
      },
    ],
    buildConfig: (values) => ({
      type: 'stdio',
      command: 'npx',
      args: [
        '-y',
        '@larksuiteoapi/lark-mcp',
        'mcp',
        '-a',
        str(values, 'appId'),
        '-s',
        str(values, 'appSecret'),
        ...(str(values, 'domain') ? ['--domain', str(values, 'domain')] : []),
      ],
      env: {},
    }),
  },
  {
    id: 'microsoft365',
    serverName: 'ms-365',
    icon: 'mail',
    nameKey: 'connector.ms365.name',
    descriptionKey: 'connector.ms365.description',
    worksWithKey: 'connector.ms365.worksWith',
    provenance: 'community',
    packageName: '@softeria/ms-365-mcp-server',
    docsUrl: 'https://github.com/softeria/ms-365-mcp-server',
    status: 'available',
    postConnectHintKey: 'connector.ms365.loginHint',
    fields: [
      {
        key: 'readOnly',
        type: 'checkbox',
        labelKey: 'connector.ms365.readOnly',
        // Default ON: the agent reads mail and calendar and shows you drafts,
        // but cannot send or move anything. Matches the Work-mode promise.
        defaultValue: true,
        hintKey: 'connector.ms365.readOnlyHint',
      },
      {
        key: 'orgMode',
        type: 'checkbox',
        labelKey: 'connector.ms365.orgMode',
        defaultValue: false,
        hintKey: 'connector.ms365.orgModeHint',
      },
    ],
    // No credentials here by design: this server uses a device-code login, so
    // nothing secret is written into the MCP config file.
    buildConfig: (values) => ({
      type: 'stdio',
      command: 'npx',
      args: [
        '-y',
        '@softeria/ms-365-mcp-server',
        '--preset',
        'mail,calendar',
        ...(values.readOnly ? ['--read-only'] : []),
        ...(values.orgMode ? ['--org-mode'] : []),
      ],
      env: {},
    }),
  },
  {
    id: 'slack',
    serverName: 'slack',
    icon: 'tag',
    nameKey: 'connector.slack.name',
    descriptionKey: 'connector.slack.description',
    worksWithKey: 'connector.slack.worksWith',
    provenance: 'community',
    status: 'coming-soon',
    fields: [],
  },
  {
    id: 'notion',
    serverName: 'notion',
    icon: 'description',
    nameKey: 'connector.notion.name',
    descriptionKey: 'connector.notion.description',
    worksWithKey: 'connector.notion.worksWith',
    provenance: 'official',
    status: 'coming-soon',
    fields: [],
  },
  {
    id: 'googleWorkspace',
    serverName: 'google-workspace',
    icon: 'event',
    nameKey: 'connector.google.name',
    descriptionKey: 'connector.google.description',
    worksWithKey: 'connector.google.worksWith',
    provenance: 'community',
    status: 'coming-soon',
    fields: [],
  },
  {
    id: 'hubspot',
    serverName: 'hubspot',
    icon: 'contacts',
    nameKey: 'connector.hubspot.name',
    descriptionKey: 'connector.hubspot.description',
    worksWithKey: 'connector.hubspot.worksWith',
    provenance: 'official',
    status: 'coming-soon',
    fields: [],
  },
]

/** Initial form state for a connector, from each field's declared default. */
export function initialConnectorValues(
  connector: ConnectorDefinition,
): Record<string, ConnectorFieldValue> {
  const values: Record<string, ConnectorFieldValue> = {}
  for (const field of connector.fields) {
    if (field.type === 'checkbox') values[field.key] = field.defaultValue
    else if (field.type === 'select') values[field.key] = field.defaultValue
    else values[field.key] = ''
  }
  return values
}

/** True when every required text field has a non-empty value. */
export function isConnectorFormComplete(
  connector: ConnectorDefinition,
  values: Record<string, ConnectorFieldValue>,
): boolean {
  return connector.fields.every((field) => {
    if (field.type !== 'text' && field.type !== 'password') return true
    if (!field.required) return true
    return str(values, field.key).length > 0
  })
}
