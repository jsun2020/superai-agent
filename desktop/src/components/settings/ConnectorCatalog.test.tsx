import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string) => key,
}))

import { ConnectorCatalog } from './ConnectorCatalog'
import {
  CONNECTOR_CATALOG,
  initialConnectorValues,
  isConnectorFormComplete,
} from '../../constants/connectorCatalog'
import { useMcpStore } from '../../stores/mcpStore'
import { useUIStore } from '../../stores/uiStore'

const createServer = vi.fn()
const addToast = vi.fn()

describe('ConnectorCatalog', () => {
  beforeEach(() => {
    createServer.mockReset()
    createServer.mockResolvedValue({ name: 'lark-mcp' })
    addToast.mockReset()
    useMcpStore.setState({ servers: [], createServer } as Partial<
      ReturnType<typeof useMcpStore.getState>
    >)
    useUIStore.setState({ addToast } as Partial<ReturnType<typeof useUIStore.getState>>)
  })

  it('renders a card for every catalog entry', () => {
    render(<ConnectorCatalog />)
    for (const connector of CONNECTOR_CATALOG) {
      expect(screen.getByTestId(`connector-card-${connector.id}`)).toBeInTheDocument()
    }
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

  it('builds the documented Feishu stdio command from the form', async () => {
    render(<ConnectorCatalog />)
    fireEvent.click(screen.getByTestId('connector-connect-feishu'))

    fireEvent.change(screen.getByTestId('connector-field-appId'), {
      target: { value: 'cli_test123' },
    })
    fireEvent.change(screen.getByTestId('connector-field-appSecret'), {
      target: { value: 'secret_test' },
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('connector-submit'))
    })

    await waitFor(() => expect(createServer).toHaveBeenCalled())
    const [name, payload] = createServer.mock.calls[0]!
    expect(name).toBe('lark-mcp')
    expect(payload.scope).toBe('user')
    expect(payload.config).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@larksuiteoapi/lark-mcp', 'mcp', '-a', 'cli_test123', '-s', 'secret_test'],
      env: {},
    })
  })

  it('adds --domain only for international Lark', async () => {
    render(<ConnectorCatalog />)
    fireEvent.click(screen.getByTestId('connector-connect-feishu'))

    fireEvent.change(screen.getByTestId('connector-field-appId'), { target: { value: 'a' } })
    fireEvent.change(screen.getByTestId('connector-field-appSecret'), { target: { value: 'b' } })
    fireEvent.change(screen.getByTestId('connector-field-domain'), {
      target: { value: 'https://open.larksuite.com' },
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('connector-submit'))
    })

    await waitFor(() => expect(createServer).toHaveBeenCalled())
    const args = createServer.mock.calls[0]![1].config.args
    expect(args).toContain('--domain')
    expect(args[args.indexOf('--domain') + 1]).toBe('https://open.larksuite.com')
  })

  it('warns that the Feishu secret is stored in plain text', () => {
    render(<ConnectorCatalog />)
    fireEvent.click(screen.getByTestId('connector-connect-feishu'))
    expect(screen.getByTestId('connector-security-note')).toBeInTheDocument()
  })

  it('defaults Microsoft 365 to read-only and stores no credentials', async () => {
    render(<ConnectorCatalog />)
    fireEvent.click(screen.getByTestId('connector-connect-microsoft365'))

    expect(screen.getByTestId('connector-field-readOnly')).toBeChecked()
    expect(screen.getByTestId('connector-field-orgMode')).not.toBeChecked()

    await act(async () => {
      fireEvent.click(screen.getByTestId('connector-submit'))
    })

    await waitFor(() => expect(createServer).toHaveBeenCalled())
    const config = createServer.mock.calls[0]![1].config
    expect(config.args).toEqual([
      '-y',
      '@softeria/ms-365-mcp-server',
      '--preset',
      'mail,calendar',
      '--read-only',
    ])
    // Device-code auth: nothing secret may be written into the MCP config.
    expect(config.env).toEqual({})
  })

  it('drops --read-only when the user turns it off', async () => {
    render(<ConnectorCatalog />)
    fireEvent.click(screen.getByTestId('connector-connect-microsoft365'))
    fireEvent.click(screen.getByTestId('connector-field-readOnly'))

    await act(async () => {
      fireEvent.click(screen.getByTestId('connector-submit'))
    })

    await waitFor(() => expect(createServer).toHaveBeenCalled())
    expect(createServer.mock.calls[0]![1].config.args).not.toContain('--read-only')
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
})

describe('connector form validation', () => {
  const feishu = CONNECTOR_CATALOG.find((c) => c.id === 'feishu')!
  const ms365 = CONNECTOR_CATALOG.find((c) => c.id === 'microsoft365')!

  it('requires both Feishu credentials before connecting', () => {
    const values = initialConnectorValues(feishu)
    expect(isConnectorFormComplete(feishu, values)).toBe(false)
    expect(isConnectorFormComplete(feishu, { ...values, appId: 'a' })).toBe(false)
    expect(isConnectorFormComplete(feishu, { ...values, appId: 'a', appSecret: 'b' })).toBe(true)
    // Whitespace is not a credential.
    expect(isConnectorFormComplete(feishu, { ...values, appId: ' ', appSecret: ' ' })).toBe(false)
  })

  it('needs no input for the device-code connector', () => {
    expect(isConnectorFormComplete(ms365, initialConnectorValues(ms365))).toBe(true)
    expect(initialConnectorValues(ms365)).toEqual({ readOnly: true, orgMode: false })
  })

  it('every available connector can build a config', () => {
    for (const connector of CONNECTOR_CATALOG) {
      if (connector.status === 'available') {
        expect(typeof connector.buildConfig).toBe('function')
      }
    }
  })
})
