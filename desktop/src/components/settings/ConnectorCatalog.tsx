import { useEffect, useState } from 'react'
import { Button } from '../shared/Button'
import { Input } from '../shared/Input'
import { Modal } from '../shared/Modal'
import { workApi } from '../../api/work'
import { useTranslation } from '../../i18n'
import { pickLocalized } from '../../lib/localized'
import { useMcpStore } from '../../stores/mcpStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import { useWorkStore } from '../../stores/workStore'
import type { Connector, ConnectorField, ConnectorFieldValue } from '../../types/work'

type Props = {
  /** Working directory passed through to mcpStore.createServer. */
  cwd?: string
}

/** Initial form state for a connector, from each field's declared default. */
export function initialConnectorValues(
  fields: readonly ConnectorField[],
): Record<string, ConnectorFieldValue> {
  const values: Record<string, ConnectorFieldValue> = {}
  for (const field of fields) {
    if (field.type === 'checkbox') values[field.key] = field.defaultValue
    else if (field.type === 'select') values[field.key] = field.defaultValue
    else values[field.key] = ''
  }
  return values
}

/** True when every required text field has a non-empty value. */
export function isConnectorFormComplete(
  fields: readonly ConnectorField[],
  values: Record<string, ConnectorFieldValue>,
): boolean {
  return fields.every((field) => {
    if (field.type !== 'text' && field.type !== 'password') return true
    if (!field.required) return true
    const value = values[field.key]
    return typeof value === 'string' && value.trim().length > 0
  })
}

/**
 * One-click MCP connectors. The catalog is a folder of JSON files in
 * ~/.superai/connectors served by the local server; this component only
 * renders it and funnels the result into the existing createServer path.
 * The server also renders the config from the form values, so the template
 * format has exactly one implementation.
 */
export function ConnectorCatalog({ cwd }: Props) {
  const t = useTranslation()
  const locale = useSettingsStore((s) => s.locale)
  const createServer = useMcpStore((s) => s.createServer)
  const servers = useMcpStore((s) => s.servers)
  const addToast = useUIStore((s) => s.addToast)
  const connectors = useWorkStore((s) => s.connectors)
  const homePath = useWorkStore((s) => s.homePath)
  const fetchConnectors = useWorkStore((s) => s.fetchConnectors)
  const fetchHome = useWorkStore((s) => s.fetchHome)

  const [active, setActive] = useState<Connector | null>(null)
  const [serverName, setServerName] = useState('')
  const [values, setValues] = useState<Record<string, ConnectorFieldValue>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    void fetchConnectors()
    void fetchHome()
  }, [fetchConnectors, fetchHome])

  const L = (text: Parameters<typeof pickLocalized>[0]) => pickLocalized(text, locale)

  const openConnector = (connector: Connector) => {
    setActive(connector)
    setServerName(connector.serverName)
    setValues(initialConnectorValues(connector.fields))
  }

  const closeConnector = () => {
    setActive(null)
    setValues({})
  }

  const isConnected = (connector: Connector) =>
    servers.some((server) => server.name === connector.serverName)

  const canSubmit =
    !!active &&
    active.status === 'available' &&
    serverName.trim().length > 0 &&
    isConnectorFormComplete(active.fields, values)

  const handleConnect = async () => {
    if (!active || !canSubmit) return
    setIsSubmitting(true)
    try {
      const { config } = await workApi.renderConnector(active.id, values)
      await createServer(serverName.trim(), { scope: 'user', config }, cwd)
      addToast({ type: 'success', message: t('connector.connected') })
      if (active.postConnectHint) {
        addToast({ type: 'info', message: L(active.postConnectHint) })
      }
      closeConnector()
    } catch (error) {
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('connector.connectFailed'),
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <section className="mb-8" data-testid="connector-catalog">
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="text-[1.35rem] font-semibold text-[var(--color-text-primary)]">
          {t('connector.sectionTitle')}
        </h3>
      </div>
      <p className="mb-1 text-sm text-[var(--color-text-secondary)]">
        {t('connector.sectionDescription')}
      </p>
      {homePath && (
        <p className="mb-4 text-xs text-[var(--color-text-tertiary)]" data-testid="connector-folder-hint">
          {t('connector.folderHint')}{' '}
          <code className="rounded bg-[var(--color-surface-container)] px-1 py-0.5 font-[var(--font-mono)]">
            {homePath}
          </code>
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {connectors.map((connector) => {
          const comingSoon = connector.status === 'coming-soon'
          const connected = isConnected(connector)
          return (
            <div
              key={connector.id}
              data-testid={`connector-card-${connector.id}`}
              className={`flex flex-col gap-2 rounded-2xl border p-4 ${
                comingSoon
                  ? 'border-dashed border-[var(--color-border)] bg-[var(--color-surface-container-low)] opacity-70'
                  : 'border-[var(--color-border)] bg-[var(--color-surface)]'
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="material-symbols-outlined text-[20px] text-[var(--color-text-secondary)]"
                >
                  {connector.icon}
                </span>
                <span className="text-sm font-semibold text-[var(--color-text-primary)]">
                  {L(connector.name)}
                </span>
                <span
                  data-testid={`connector-provenance-${connector.id}`}
                  className="ml-auto rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-text-tertiary)]"
                >
                  {connector.provenance === 'official'
                    ? t('connector.official')
                    : t('connector.community')}
                </span>
              </div>

              <p className="text-xs leading-snug text-[var(--color-text-secondary)]">
                {L(connector.description)}
              </p>
              <p className="text-[11px] text-[var(--color-text-tertiary)]">
                {L(connector.worksWith)}
              </p>

              <div className="mt-2 flex items-center gap-2">
                {comingSoon ? (
                  <span className="text-xs text-[var(--color-text-tertiary)]">
                    {t('connector.comingSoon')}
                  </span>
                ) : (
                  <>
                    <Button
                      variant="secondary"
                      onClick={() => openConnector(connector)}
                      data-testid={`connector-connect-${connector.id}`}
                    >
                      {connected ? t('connector.reconfigure') : t('connector.connect')}
                    </Button>
                    {connected && (
                      <span className="text-xs text-[var(--color-success)]">
                        {t('connector.alreadyAdded')}
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <Modal
        open={!!active}
        onClose={closeConnector}
        title={active ? L(active.name) : undefined}
        footer={
          <>
            <Button variant="secondary" onClick={closeConnector}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={handleConnect}
              disabled={!canSubmit}
              loading={isSubmitting}
              data-testid="connector-submit"
            >
              {t('connector.connect')}
            </Button>
          </>
        }
      >
        {active && (
          <div className="flex flex-col gap-4" data-testid="connector-form">
            <p className="text-sm text-[var(--color-text-secondary)]">
              {L(active.description)}
            </p>

            {active.packageName && (
              <p className="text-xs text-[var(--color-text-tertiary)]">
                {t('connector.runsPackage')}{' '}
                <code className="rounded bg-[var(--color-surface-container)] px-1 py-0.5 font-[var(--font-mono)]">
                  {active.packageName}
                </code>
                {active.provenance === 'community' && ` — ${t('connector.communityWarning')}`}
              </p>
            )}

            <Input
              label={t('connector.serverName')}
              required
              value={serverName}
              onChange={(e) => setServerName(e.target.value)}
            />

            {active.fields.map((field) => {
              if (field.type === 'checkbox') {
                return (
                  <label key={field.key} className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      data-testid={`connector-field-${field.key}`}
                      checked={values[field.key] === true}
                      onChange={(e) =>
                        setValues((prev) => ({ ...prev, [field.key]: e.target.checked }))
                      }
                      className="mt-1 h-4 w-4 rounded border-[var(--color-border)] accent-[var(--color-brand)]"
                    />
                    <span>
                      <span className="text-sm text-[var(--color-text-primary)]">
                        {L(field.label)}
                      </span>
                      {field.hint && (
                        <span className="block text-xs text-[var(--color-text-tertiary)]">
                          {L(field.hint)}
                        </span>
                      )}
                    </span>
                  </label>
                )
              }

              if (field.type === 'select') {
                return (
                  <div key={field.key} className="flex flex-col gap-1">
                    <label className="text-sm font-medium text-[var(--color-text-primary)]">
                      {L(field.label)}
                    </label>
                    <select
                      data-testid={`connector-field-${field.key}`}
                      value={String(values[field.key] ?? field.defaultValue)}
                      onChange={(e) =>
                        setValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                      }
                      className="h-10 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-border-focus)]"
                    >
                      {field.options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {L(option.label)}
                        </option>
                      ))}
                    </select>
                    {field.hint && (
                      <span className="text-xs text-[var(--color-text-tertiary)]">{L(field.hint)}</span>
                    )}
                  </div>
                )
              }

              return (
                <Input
                  key={field.key}
                  label={L(field.label)}
                  required={field.required}
                  type={field.type === 'password' ? 'password' : 'text'}
                  placeholder={field.placeholder}
                  data-testid={`connector-field-${field.key}`}
                  value={String(values[field.key] ?? '')}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                  }
                />
              )
            })}

            {active.securityNote && (
              <p
                data-testid="connector-security-note"
                className="rounded-[var(--radius-md)] border border-[var(--color-warning)]/25 bg-[var(--color-warning)]/8 px-3 py-2 text-xs text-[var(--color-text-secondary)]"
              >
                {L(active.securityNote)}
              </p>
            )}
          </div>
        )}
      </Modal>
    </section>
  )
}
