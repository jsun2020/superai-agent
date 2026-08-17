import { useEffect } from 'react'
import { useTranslation } from '../../i18n'
import { pickLocalized } from '../../lib/localized'
import { useSettingsStore } from '../../stores/settingsStore'
import { useWorkStore } from '../../stores/workStore'
import type { SessionRole } from '../../types/settings'
import type { WorkRole } from '../../types/work'

type Props = {
  value: SessionRole | null
  onChange: (role: SessionRole | null) => void
}

/**
 * Work-mode role picker, rendered from ~/.superai/roles via the server. The
 * desktop ships no role list of its own: a role the user adds as a file shows
 * up here on the next visit with no rebuild.
 *
 * Clicking a selected card deselects it, which returns the session to the
 * plain document experience (no role stamped).
 */
export function RoleCards({ value, onChange }: Props) {
  const t = useTranslation()
  const locale = useSettingsStore((s) => s.locale)
  const roles = useWorkStore((s) => s.roles)
  const loaded = useWorkStore((s) => s.rolesLoaded)
  const fetchRoles = useWorkStore((s) => s.fetchRoles)

  useEffect(() => {
    void fetchRoles()
  }, [fetchRoles])

  // Nothing to pick from (folder emptied, or every role disabled): render
  // nothing rather than an empty labelled grid.
  if (loaded && roles.length === 0) return null

  return (
    <div className="mt-6 w-full" data-testid="work-mode-roles">
      <p className="mb-2.5 text-xs text-[var(--color-text-tertiary)]">
        {t('empty.rolePickerLabel')}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {roles.map((role: WorkRole) => {
          const selected = value === role.id
          return (
            <button
              key={role.id}
              type="button"
              aria-pressed={selected}
              data-testid={`role-card-${role.id}`}
              onClick={() => onChange(selected ? null : role.id)}
              className={`flex flex-col gap-1.5 rounded-xl border p-3.5 text-left transition-colors ${
                selected
                  ? 'border-[var(--color-brand)] bg-[var(--color-surface-hover)]'
                  : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-focus)]'
              }`}
            >
              <span
                aria-hidden="true"
                className={`material-symbols-outlined text-[20px] ${
                  selected ? 'text-[var(--color-brand)]' : 'text-[var(--color-text-secondary)]'
                }`}
              >
                {role.icon}
              </span>
              <span className="text-sm font-semibold text-[var(--color-text-primary)]">
                {pickLocalized(role.name, locale)}
              </span>
              <span className="text-xs leading-snug text-[var(--color-text-secondary)]">
                {pickLocalized(role.tagline, locale)}
              </span>
              <span className="mt-1 border-t border-[var(--color-border-separator)] pt-1.5 text-[11px] text-[var(--color-text-tertiary)]">
                {pickLocalized(role.worksWith, locale)}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
