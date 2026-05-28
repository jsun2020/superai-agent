import { useState } from 'react'
import { terminalApi } from '../../api/terminal'
import { useTranslation } from '../../i18n'
import { useUIStore } from '../../stores/uiStore'

export function CodexOfficialLogin() {
  const t = useTranslation()
  const [error, setError] = useState<string | null>(null)

  const handleLogin = () => {
    if (!terminalApi.isAvailable()) {
      setError(t('settings.codexOfficialLogin.terminalUnavailable'))
      return
    }

    setError(null)
    useUIStore.getState().setPendingTerminalCommand('codex logout\ncodex login\n')
    useUIStore.getState().setPendingSettingsTab('terminal')
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm text-[var(--color-text-secondary)]">
        {t('settings.codexOfficialLogin.intro')}
      </div>
      <button
        type="button"
        onClick={handleLogin}
        className="self-start rounded-md bg-[image:var(--gradient-btn-primary)] px-4 py-2 text-sm text-[var(--color-btn-primary-fg)] shadow-[var(--shadow-button-primary)] hover:brightness-105 transition-opacity"
      >
        {t('settings.codexOfficialLogin.loginButton')}
      </button>
      {error && (
        <div className="text-xs text-[var(--color-error)]">
          {t('settings.codexOfficialLogin.errorPrefix')}{error}
        </div>
      )}
    </div>
  )
}
