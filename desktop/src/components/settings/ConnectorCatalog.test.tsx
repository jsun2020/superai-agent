import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string) => key,
}))

const renderConnector = vi.fn()
vi.mock('../../api/work', () => ({
  workApi: {
    home: vi.fn(),
    roles: vi.fn(),
    connectors: vi.fn(),
    renderConnector: (...args: unknown[]) => renderConnector(...args),
  },
}))

import {
  ConnectorCatalog,
  initialConnectorValues,
  isConnectorFormComplete,
} from './ConnectorCatalog'
import { useMcpStore } from '../../stores/mcpStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import { useWorkStore } from '../../stores/workStore'
import type { Connector } from '../../types/work'

/**
 * What GET /api/work/connectors returns for a freshly seeded ~/.superai —
 * the shape the server ships, minus the config templates (rendered
 * server-side, so the desktop never sees them).
 */
const SEEDED_CONNECTORS: Connector[] = [
  {
    id: 'feishu',
    serverName: 'lark-mcp',
    icon: 'forum',
    name: { en: 'Feishu / Lark', zh: '飞书 / Lark' },
    description: { en: 'Feishu docs, sheets, messages.', zh: '飞书文档。' },
    worksWith: { en: 'Docs · Sheets', zh: '文档 · 表格' },
    provenance: 'official',
    packageName: '@larksuiteoapi/lark-mcp',
    status: 'available',
    securityNote: { en: 'Secret stored in plain text.' },
    fields: [
      { key: 'appId', type: 'text', label: { en: 'App ID' }, required: true },
      { key: 'appSecret', type: 'password', label: { en: 'App Secret' }, required: true },
      {
        key: 'domain',
        type: 'select',
        label: { en: 'Platform' },
        defaultValue: '',
        options: [
          { value: '', label: { en: 'Feishu' } },
          { value: 'https://open.larksuite.com', label: { en: 'Lark' } },
        ],
      },
    ],
    source: 'file',
  },
  {
    id: 'microsoft365',
    serverName: 'ms-365',
    icon: 'mail',
    name: 'Microsoft 365',
    description: { en: 'Outlook via Graph.' },
    worksWith: { en: 'Mail · Calendar' },
    provenance: 'community',
    packageName: '@softeria/ms-365-mcp-server',
    status: 'available',
    postConnectHint: { en: 'Now run the sign-in.' },
    fields: [
      { key: 'readOnly', type: 'checkbox', label: { en: 'Read-only' }, defaultValue: true },
      { key: 'orgMode', type: 'checkbox', label: { en: 'Work account' }, defaultValue: false },
    ],
    source: 'file',
  },
  {
    id: 'slack',
    serverName: 'slack',
    icon: 'tag',
    name: 'Slack',
    description: { en: 'Coming.' },
    worksWith: { en: 'Channels' },
    provenance: 'community',
    status: 'coming-soon',
    fields: [],
    source: 'file',
  },
]

const createServer = vi.fn()
const addToast = vi.fn()
const fetchConnectors = vi.fn()
const fetchHome = vi.fn()

describe('ConnectorCatalog', () => {
  beforeEach(() => {
    createServer.mockReset()
    createServer.mockResolvedValue({ name: 'lark-mcp' })
    addToast.mockReset()
    renderConnector.mockReset()
    renderConnector.mockImplementation(async (id: string, values: Record<string, unknown>) => ({
      // A stand-in for the server's renderer: enough to prove the desktop
      // forwards the form and hands the RESULT to createServer untouched.
      config: { type: 'stdio', command: 'npx', args: [id, JSON.stringify(values)], env: {} },
    }))
    fetchConnectors.mockReset()
    fetchConnectors.mockResolvedValue(undefined)
    fetchHome.mockReset()
    fetchHome.mockResolvedValue(undefined)
    useMcpStore.setState({ servers: [], createServer } as Partial<
      ReturnType<typeof useMcpStore.getState>
    >)
    useUIStore.setState({ addToast } as Partial<ReturnType<typeof useUIStore.getState>>)
    useSettingsStore.setState({ locale: 'en' } as Partial<ReturnType<typeof useSettingsStore.getState>>)
    useWorkStore.setState({
      connectors: SEEDED_CONNECTORS,
      connectorsLoaded: true,
      homePath: 'C:\\Users\\me\\.superai',
      fetchConnectors,
      fetchHome,
    } as Partial<ReturnType<typeof useWorkStore.getState>>)
  })

  it('asks the server for the catalog and the folder path on mount', () => {
    render(<ConnectorCatalog />)
    expect(fetchConnectors).toHaveBeenCalledTimes(1)
    expect(fetchHome).toHaveBeenCalledTimes(1)
  })

  it('renders a card for every connector the server returned', () => {
    render(<ConnectorCatalog />)
    for (const connector of SEEDED_CONNECTORS) {
      expect(screen.getByTestId(`connector-card-${connector.id}`)).toBeInTheDocument()
    }
  })

  it('tells the user where the files live', () => {
    render(<ConnectorCatalog />)
    expect(screen.getByTestId('connector-folder-hint')).toHaveTextContent('C:\\Users\\me\\.superai')
  })

  it('renders names in the current locale', () => {
    useSettingsStore.setState({ locale: 'zh' } as Partial<ReturnType<typeof useSettingsStore.getState>>)
    render(<ConnectorCatalog />)
    expect(screen.getByText('飞书 / Lark')).toBeInTheDocument()
    // Plain-string names are the same in every locale.
    expect(screen.getByText('Microsoft 365')).toBeInTheDocument()
  })

  it('offers Connect only for available entries', () => {
    render(<ConnectorCatalog />)
    expect(screen.getByTestId('connector-connect-feishu')).toBeInTheDocument()
    expect(screen.getByTestId('connector-connect-microsoft365')).toBeInTheDocument()
    // Coming-soon entries must not present a button that does nothing.
    expect(screen.queryByTestId('connector-connect-slack')).not.toBeInTheDocument()
  })

  it('labels each connector as official or community', () => {
    // The user is about to hand this thing a mailbox; provenance is not a detail.
    render(<ConnectorCatalog />)
    expect(screen.getByTestId('connector-provenance-feishu')).toHaveTextContent('connector.official')
    expect(screen.getByTestId('connector-provenance-microsoft365')).toHaveTextContent(
      'connector.community',
    )
  })

  it('sends the form to the server renderer and hands its config to createServer unchanged', async () => {
    render(<ConnectorCatalog />)
    fireEvent.click(screen.getByTestId('connector-connect-feishu'))

    fireEvent.change(screen.getByTestId('connector-field-appId'), {
      target: { value: 'cli_test123' },
    })
    fireEvent.change(screen.getByTestId('connector-field-appSecret'), {
      target: { value: 'secret_test' },
    })
    fireEvent.change(screen.getByTestId('connector-field-domain'), {
      target: { value: 'https://open.larksuite.com' },
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('connector-submit'))
    })

    await waitFor(() => expect(createServer).toHaveBeenCalled())
    expect(renderConnector).toHaveBeenCalledWith('feishu', {
      appId: 'cli_test123',
      appSecret: 'secret_test',
      domain: 'https://open.larksuite.com',
    })
    const [name, payload] = createServer.mock.calls[0]!
    expect(name).toBe('lark-mcp')
    expect(payload.scope).toBe('user')
    expect(payload.config).toEqual(
      (await renderConnector.mock.results[0]!.value).config,
    )
  })

  it('warns that the Feishu secret is stored in plain text', () => {
    render(<ConnectorCatalog />)
    fireEvent.click(screen.getByTestId('connector-connect-feishu'))
    expect(screen.getByTestId('connector-security-note')).toBeInTheDocument()
  })

  it('defaults Microsoft 365 to read-only and forwards the checkbox state', async () => {
    render(<ConnectorCatalog />)
    fireEvent.click(screen.getByTestId('connector-connect-microsoft365'))

    expect(screen.getByTestId('connector-field-readOnly')).toBeChecked()
    expect(screen.getByTestId('connector-field-orgMode')).not.toBeChecked()

    await act(async () => {
      fireEvent.click(screen.getByTestId('connector-submit'))
    })

    await waitFor(() => expect(createServer).toHaveBeenCalled())
    expect(renderConnector).toHaveBeenCalledWith('microsoft365', { readOnly: true, orgMode: false })
    // The post-connect hint comes from the file, in the current locale.
    expect(addToast).toHaveBeenCalledWith({ type: 'info', message: 'Now run the sign-in.' })
  })

  it('forwards read-only OFF when the user unticks it', async () => {
    render(<ConnectorCatalog />)
    fireEvent.click(screen.getByTestId('connector-connect-microsoft365'))
    fireEvent.click(screen.getByTestId('connector-field-readOnly'))

    await act(async () => {
      fireEvent.click(screen.getByTestId('connector-submit'))
    })

    await waitFor(() => expect(createServer).toHaveBeenCalled())
    expect(renderConnector).toHaveBeenCalledWith('microsoft365', { readOnly: false, orgMode: false })
  })

  it('surfaces a failure instead of reporting success', async () => {
    createServer.mockRejectedValue(new Error('npx not found'))
    render(<ConnectorCatalog />)
    fireEvent.click(screen.getByTestId('connector-connect-microsoft365'))

    await act(async () => {
      fireEvent.click(screen.getByTestId('connector-submit'))
    })

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith({ type: 'error', message: 'npx not found' }),
    )
  })

  it('surfaces a render failure too, and never calls createServer with nothing', async () => {
    renderConnector.mockRejectedValue(new Error('Unknown connector: feishu'))
    render(<ConnectorCatalog />)
    fireEvent.click(screen.getByTestId('connector-connect-microsoft365'))

    await act(async () => {
      fireEvent.click(screen.getByTestId('connector-submit'))
    })

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith({ type: 'error', message: 'Unknown connector: feishu' }),
    )
    expect(createServer).not.toHaveBeenCalled()
  })
})

describe('connector form validation', () => {
  const feishu = SEEDED_CONNECTORS.find((c) => c.id === 'feishu')!
  const ms365 = SEEDED_CONNECTORS.find((c) => c.id === 'microsoft365')!

  it('requires both Feishu credentials before connecting', () => {
    const values = initialConnectorValues(feishu.fields)
    expect(isConnectorFormComplete(feishu.fields, values)).toBe(false)
    expect(isConnectorFormComplete(feishu.fields, { ...values, appId: 'a' })).toBe(false)
    expect(isConnectorFormComplete(feishu.fields, { ...values, appId: 'a', appSecret: 'b' })).toBe(true)
    // Whitespace is not a credential.
    expect(isConnectorFormComplete(feishu.fields, { ...values, appId: ' ', appSecret: ' ' })).toBe(false)
  })

  it('needs no input for the device-code connector', () => {
    expect(isConnectorFormComplete(ms365.fields, initialConnectorValues(ms365.fields))).toBe(true)
    expect(initialConnectorValues(ms365.fields)).toEqual({ readOnly: true, orgMode: false })
  })
})
