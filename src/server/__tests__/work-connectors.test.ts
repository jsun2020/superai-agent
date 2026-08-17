import { describe, expect, test } from 'bun:test'
import * as fs from 'fs'
import * as path from 'path'

import { handleWorkApi } from '../api/work.js'
import { pickLocalized } from '../services/localized.js'
import {
  findConnector,
  initialConnectorValues,
  loadConnectors,
  renderConnectorConfig,
  validateConnector,
} from '../services/workConnectors.js'
import { BUILT_IN_CONNECTORS } from '../services/workplaceDefaults.js'
import { useTempSuperaiHome } from './fixtures/tempSuperaiHome'

const home = useTempSuperaiHome()

const connectorFile = (id: string) => path.join(home.dir, 'connectors', `${id}.json`)
const writeConnector = (id: string, value: unknown) => {
  fs.mkdirSync(path.dirname(connectorFile(id)), { recursive: true })
  fs.writeFileSync(
    connectorFile(id),
    typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    'utf-8',
  )
}

const feishu = BUILT_IN_CONNECTORS.find((c) => c.id === 'feishu')!
const ms365 = BUILT_IN_CONNECTORS.find((c) => c.id === 'microsoft365')!

describe('shipped defaults', () => {
  test('every built-in passes its own validator', () => {
    for (const connector of BUILT_IN_CONNECTORS) {
      expect(validateConnector(connector)).toBeNull()
    }
  })

  test('the seeded folder yields the built-ins from disk, in order', () => {
    const connectors = loadConnectors()
    expect(connectors.map((c) => c.id)).toEqual([
      'feishu',
      'microsoft365',
      'slack',
      'notion',
      'google-workspace',
      'hubspot',
    ])
    for (const c of connectors) expect(c.source).toBe('file')
  })

  test('renders the documented Feishu stdio command', () => {
    // Copied from the vendor's docs, not inferred (LL-027): a wrong flag
    // produces a server that starts and silently does nothing.
    const values = { ...initialConnectorValues(feishu.fields), appId: 'cli_test123', appSecret: 'secret_test' }
    expect(renderConnectorConfig(feishu.config!, values)).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@larksuiteoapi/lark-mcp', 'mcp', '-a', 'cli_test123', '-s', 'secret_test'],
      env: {},
    })
  })

  test('Feishu adds --domain only when Lark is selected', () => {
    const values = {
      appId: 'a',
      appSecret: 's',
      domain: 'https://open.larksuite.com',
    }
    expect(renderConnectorConfig(feishu.config!, values)).toMatchObject({
      args: ['-y', '@larksuiteoapi/lark-mcp', 'mcp', '-a', 'a', '-s', 's', '--domain', 'https://open.larksuite.com'],
    })
  })

  test('Microsoft 365 defaults to read-only and adds flags from the checkboxes', () => {
    const defaults = initialConnectorValues(ms365.fields)
    expect(defaults).toEqual({ readOnly: true, orgMode: false })
    expect(renderConnectorConfig(ms365.config!, defaults)).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@softeria/ms-365-mcp-server', '--preset', 'mail,calendar', '--read-only'],
      env: {},
    })
    expect(renderConnectorConfig(ms365.config!, { readOnly: false, orgMode: true }).args).toEqual([
      '-y',
      '@softeria/ms-365-mcp-server',
      '--preset',
      'mail,calendar',
      '--org-mode',
    ])
  })
})

describe('template rendering', () => {
  test('substitutes {{key}} in args, env, url and headers, trimming values', () => {
    expect(
      renderConnectorConfig(
        { type: 'stdio', command: '{{cmd}}', args: ['--token={{token}}'], env: { TOKEN: '{{ token }}' } },
        { cmd: ' node ', token: ' abc ' },
      ),
    ).toEqual({ type: 'stdio', command: 'node', args: ['--token=abc'], env: { TOKEN: 'abc' } })

    expect(
      renderConnectorConfig(
        { type: 'http', url: 'https://x/{{ws}}', headers: { Authorization: 'Bearer {{token}}' } },
        { ws: 'w1', token: 't' },
      ),
    ).toEqual({ type: 'http', url: 'https://x/w1', headers: { Authorization: 'Bearer t' } })
  })

  test('unless: adds args when a field is blank or unchecked', () => {
    const template = {
      type: 'stdio' as const,
      command: 'x',
      args: [{ unless: 'verbose', then: ['--quiet'] }, { unless: 'region', then: ['--region', 'default'] }],
    }
    expect(renderConnectorConfig(template, { verbose: false, region: '' }).args).toEqual(['--quiet', '--region', 'default'])
    expect(renderConnectorConfig(template, { verbose: true, region: 'eu' }).args).toEqual([])
  })

  test('a missing value renders as empty, never as the literal placeholder', () => {
    // The form blocks submit on empty REQUIRED fields; an optional blank
    // must not leak "{{key}}" into a command line.
    expect(renderConnectorConfig({ type: 'stdio', command: 'x', args: ['{{missing}}'] }, {}).args).toEqual([''])
  })
})

describe('user-defined connectors', () => {
  test('a valid new file adds a connectable card', () => {
    writeConnector('mycrm', {
      serverName: 'mycrm',
      icon: 'contacts',
      name: { en: 'My CRM', zh: '我的 CRM' },
      description: 'Internal CRM',
      worksWith: 'Deals',
      provenance: 'community',
      status: 'available',
      fields: [{ key: 'token', type: 'password', label: 'Token', required: true }],
      config: { type: 'stdio', command: 'npx', args: ['-y', 'mycrm-mcp', '--token', '{{token}}'] },
    })

    const ids = loadConnectors().map((c) => c.id)
    expect(ids).toContain('mycrm')
    const mine = findConnector('mycrm')!
    expect(mine.source).toBe('file')
    expect(pickLocalized(mine.name, 'zh')).toBe('我的 CRM')
    expect(pickLocalized(mine.description, 'zh')).toBe('Internal CRM') // plain string = every locale
    expect(renderConnectorConfig(mine.config!, { token: 'T' })).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'mycrm-mcp', '--token', 'T'],
      env: {},
    })
  })

  test('a same-id file overrides only the fields it sets (e.g. promote coming-soon to available)', () => {
    writeConnector('slack', {
      status: 'available',
      packageName: '@example/slack-mcp',
      fields: [{ key: 'token', type: 'password', label: 'Bot token', required: true }],
      config: { type: 'stdio', command: 'npx', args: ['-y', '@example/slack-mcp', '{{token}}'] },
    })
    const slack = findConnector('slack')!
    expect(slack.status).toBe('available')
    expect(slack.icon).toBe('tag') // still the built-in
    expect(pickLocalized(slack.name, 'en')).toBe('Slack')
  })

  test('findConnector refuses ids that could be paths', () => {
    expect(findConnector('../x')).toBeUndefined()
    expect(findConnector('feishu/../slack')).toBeUndefined()
    expect(findConnector(42)).toBeUndefined()
  })

  test('disabled: true hides a connector', () => {
    writeConnector('hubspot', { disabled: true })
    expect(loadConnectors().map((c) => c.id)).not.toContain('hubspot')
  })

  test('an invalid file is skipped loudly and the built-in stays', () => {
    const errors: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '))
    try {
      writeConnector('feishu', '{ this is not json')
      writeConnector('broken', { serverName: 'b', icon: 'x', name: 'B', description: 'd', worksWith: 'w', provenance: 'community', status: 'available', fields: [], config: { type: 'stdio', command: '', args: [] } })
      const connectors = loadConnectors()
      expect(connectors.find((c) => c.id === 'feishu')!.source).toBe('built-in')
      expect(connectors.map((c) => c.id)).not.toContain('broken')
      expect(errors.some((e) => e.includes('feishu.json') && e.includes('not valid JSON'))).toBe(true)
      expect(errors.some((e) => e.includes('broken.json') && e.includes('"command" is required'))).toBe(true)
    } finally {
      console.error = original
    }
  })
})

describe('validator', () => {
  const base = {
    serverName: 's',
    icon: 'i',
    name: 'N',
    description: 'D',
    worksWith: 'W',
    provenance: 'official',
    status: 'coming-soon',
    fields: [],
  }
  test('names the first problem it finds', () => {
    expect(validateConnector({ ...base, serverName: '' })).toContain('serverName')
    expect(validateConnector({ ...base, provenance: 'vendor' })).toContain('provenance')
    expect(validateConnector({ ...base, name: 42 })).toContain('"name"')
    expect(validateConnector({ ...base, fields: [{ key: 'bad key', type: 'text', label: 'x' }] })).toContain('fields[0]')
    expect(validateConnector({ ...base, fields: [{ key: 'k', type: 'select', label: 'x', defaultValue: '', options: [] }] })).toContain('options')
    expect(validateConnector({ ...base, fields: [{ key: 'k', type: 'checkbox', label: 'x', defaultValue: 'yes' }] })).toContain('boolean')
    expect(validateConnector({ ...base, status: 'available' })).toContain('config')
    expect(validateConnector({ ...base, status: 'available', config: { type: 'stdio', command: 'x', args: [{ then: ['a'] }] } })).toContain('args[0]')
    expect(validateConnector({ ...base, status: 'available', config: { type: 'ftp' } })).toContain('"type"')
  })
})

describe('GET/POST /api/work', () => {
  const call = (method: string, pathname: string, body?: unknown) =>
    handleWorkApi(
      new Request(`http://localhost${pathname}`, {
        method,
        ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
      }),
      new URL(`http://localhost${pathname}`),
      pathname.split('/').filter(Boolean),
    )

  test('home reports the folder path', async () => {
    const res = await call('GET', '/api/work/home')
    expect(await res.json()).toEqual({ path: home.dir })
  })

  test('roles omit the prompt body', async () => {
    const res = await call('GET', '/api/work/roles')
    const { roles } = (await res.json()) as { roles: Array<Record<string, unknown>> }
    expect(roles.map((r) => r.id)).toEqual(['assistant', 'sales', 'analyst'])
    for (const role of roles) expect(role).not.toHaveProperty('prompt')
    expect(roles[0]).toMatchObject({ icon: 'event_available', name: { en: 'Assistant', zh: '助理' } })
  })

  test('connectors omit the config template', async () => {
    const res = await call('GET', '/api/work/connectors')
    const { connectors } = (await res.json()) as { connectors: Array<Record<string, unknown>> }
    expect(connectors).toHaveLength(6)
    for (const c of connectors) expect(c).not.toHaveProperty('config')
  })

  test('render returns exactly what mcp createServer expects', async () => {
    const res = await call('POST', '/api/work/connectors/feishu/render', {
      values: { appId: 'cli_x', appSecret: 's', domain: '', evil: { nested: true }, n: 3 },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      config: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@larksuiteoapi/lark-mcp', 'mcp', '-a', 'cli_x', '-s', 's'],
        env: {},
      },
    })
  })

  test('render refuses unknown and coming-soon connectors', async () => {
    expect((await call('POST', '/api/work/connectors/nope/render', { values: {} })).status).toBe(404)
    expect((await call('POST', '/api/work/connectors/slack/render', { values: {} })).status).toBe(400)
    expect((await call('POST', '/api/work/connectors/../x/render', { values: {} })).status).toBe(404)
  })
})

describe('files as Windows editors write them', () => {
  test('a connector JSON with a UTF-8 BOM and CRLF still parses', () => {
    // JSON.parse rejects a leading BOM outright; the loader must strip it.
    const json = JSON.stringify(
      {
        serverName: 'bomtest',
        icon: 'x',
        name: 'BOM',
        description: 'd',
        worksWith: 'w',
        provenance: 'community',
        status: 'available',
        fields: [],
        config: { type: 'stdio', command: 'x', args: [] },
      },
      null,
      2,
    ).replace(/\n/g, '\r\n')
    writeConnector('bomtest', '\uFEFF' + json)
    expect(findConnector('bomtest')?.source).toBe('file')
  })
})
