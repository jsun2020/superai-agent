import { useState } from 'react'
import { Button } from '../shared/Button'
import { Input } from '../shared/Input'
import { Modal } from '../shared/Modal'
import { useTranslation } from '../../i18n'
import { useMcpStore } from '../../stores/mcpStore'
import { useUIStore } from '../../stores/uiStore'
import {
  CONNECTOR_CATALOG,
  initialConnectorValues,
  isConnectorFormComplete,
  type ConnectorDefinition,
  type ConnectorFieldValue,
} from '../../constants/connectorCatalog'

type Props = {
  /** Working directory passed through to mcpStore.createServer. */
  cwd?: string
}

/**
 * One-click MCP connectors. Everything here funnels into the existing
 * createServer path — the catalog only spares a non-technical user from
 * hand-writing a stdio command, args array and env block.
 */
export function ConnectorCatalog({ cwd }: Props) {
  const t = useTranslation()
  const createServer = useMcpStore((s) => s.createServer)
  const servers = useMcpStore((s) => s.servers)
  const addToast = useUIStore((s) => s.addToast)

  const [active, setActive] = useState<ConnectorDefinition | null>(null)
  const [serverName, setServerName] = useState('')
  const [values, setValues] = useState<Record<string, ConnectorFieldValue>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)

  const openConnector = (connector: ConnectorDefinition) => {
    setActive(connector)
    setServerName(connector.serverName)
    setValues(initialConnectorValues(connector))
  }

  const closeConnector = () => {
    setActive(null)
    setValues({})
  }

  const isConnected = (connector: ConnectorDefinition) =>
    servers.some((server) => server.name === connector.serverName)

  const canSubmit =
    !!active &&
    !!active.buildConfig &&
    serverName.trim().length > 0 &&
    isConnectorFormComplete(active, values)

  const handleConnect = async () => {
    if (!active?.buildConfig || !canSubmit) return
    setIsSubmitting(true)
    try {
      await createServer(
        serverName.trim(),
        { scope: 'user', config: active.buildConfig(values) },
        cwd,
      )
      addToast({ type: 'success', message: t('connector.connected') })
      if (active.postConnectHintKey) {
        addToast({ type: 'info', message: t(active.postConnectHintKey) })
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
      <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
        {t('connector.sectionDescription')}
      </p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CONNECTOR_CATALOG.map((connector) => {
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
                  {t(connector.nameKey)}
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
                {t(connector.descriptionKey)}
              </p>
              <p className="text-[11px] text-[var(--color-text-tertiary)]">
                {t(connector.worksWithKey)}
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
        title={active ? t(active.nameKey) : undefined}
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
              {t(active.descriptionKey)}
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
                        {t(field.labelKey)}
                      </span>
                      {field.hintKey && (
                        <span className="block text-xs text-[var(--color-text-tertiary)]">
                          {t(field.hintKey)}
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
                      {t(field.labelKey)}
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
                          {t(option.labelKey)}
                        </option>
                      ))}
                    </select>
                  </div>
                )
              }

              return (
                <Input
                  key={field.key}
                  label={t(field.labelKey)}
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

            {active.securityNoteKey && (
              <p
                data-testid="connector-security-note"
                className="rounded-[var(--radius-md)] border border-[var(--color-warning)]/25 bg-[var(--color-warning)]/8 px-3 py-2 text-xs text-[var(--color-text-secondary)]"
              >
                {t(active.securityNoteKey)}
              </p>
            )}
          </div>
        )}
      </Modal>
    </section>
  )
}
