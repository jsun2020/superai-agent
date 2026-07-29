import { Dropdown } from '../shared/Dropdown'
import { useUIStore } from '../../stores/uiStore'
import { useTranslation } from '../../i18n'
import type { AppMode } from '../../types/settings'

function ChevronDownIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

/**
 * Codex-style product switcher: the brand text is the trigger, the second
 * word shows the active mode (Work = office users, Code = developers).
 * The choice only affects sessions created afterwards.
 */
export function ModeSwitcher() {
  const t = useTranslation()
  const appMode = useUIStore((s) => s.appMode)
  const setAppMode = useUIStore((s) => s.setAppMode)

  const items: Array<{ value: AppMode; label: string; description: string }> = [
    { value: 'work', label: t('mode.work'), description: t('mode.workDescription') },
    { value: 'code', label: t('mode.code'), description: t('mode.codeDescription') },
  ]

  return (
    <Dropdown
      items={items}
      value={appMode}
      onChange={setAppMode}
      width={260}
      trigger={
        <span
          data-testid="mode-switcher-trigger"
          role="button"
          aria-label={t('mode.switcherLabel')}
          title={t('mode.switcherLabel')}
          className="inline-flex items-center gap-1 rounded-md text-[13px] font-semibold tracking-tight text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)] px-1 -mx-1"
          style={{ fontFamily: 'var(--font-headline)' }}
        >
          <span className="whitespace-nowrap">
            SuperAI{' '}
            <span className="text-[var(--color-primary-container)]">
              {appMode === 'work' ? t('mode.work') : t('mode.code')}
            </span>
          </span>
          <span className="text-[var(--color-text-tertiary)]"><ChevronDownIcon /></span>
        </span>
      }
    />
  )
}
