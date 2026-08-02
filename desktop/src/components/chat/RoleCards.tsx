import { useTranslation, type TranslationKey } from '../../i18n'
import type { SessionRole } from '../../types/settings'

type RoleCard = {
  role: SessionRole
  icon: string
  titleKey: TranslationKey
  taglineKey: TranslationKey
  worksWithKey: TranslationKey
}

export const ROLE_CARDS: readonly RoleCard[] = [
  {
    role: 'assistant',
    icon: 'event_available',
    titleKey: 'role.assistant',
    taglineKey: 'role.assistantTagline',
    worksWithKey: 'role.assistantWorksWith',
  },
  {
    role: 'sales',
    icon: 'trending_up',
    titleKey: 'role.sales',
    taglineKey: 'role.salesTagline',
    worksWithKey: 'role.salesWorksWith',
  },
  {
    role: 'analyst',
    icon: 'insights',
    titleKey: 'role.analyst',
    taglineKey: 'role.analystTagline',
    worksWithKey: 'role.analystWorksWith',
  },
] as const

/** Example prompts shown once a role is picked, replacing the generic ones. */
export const ROLE_EXAMPLE_KEYS: Record<SessionRole, readonly TranslationKey[]> = {
  assistant: ['role.assistantExample1', 'role.assistantExample2'],
  sales: ['role.salesExample1', 'role.salesExample2'],
  analyst: ['role.analystExample1', 'role.analystExample2'],
}

type Props = {
  value: SessionRole | null
  onChange: (role: SessionRole | null) => void
}

/**
 * Work-mode role picker. Clicking a selected card deselects it, which returns
 * the session to the plain document experience (no role stamped).
 */
export function RoleCards({ value, onChange }: Props) {
  const t = useTranslation()

  return (
    <div className="mt-6 w-full" data-testid="work-mode-roles">
      <p className="mb-2.5 text-xs text-[var(--color-text-tertiary)]">
        {t('empty.rolePickerLabel')}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {ROLE_CARDS.map((card) => {
          const selected = value === card.role
          return (
            <button
              key={card.role}
              type="button"
              aria-pressed={selected}
              data-testid={`role-card-${card.role}`}
              onClick={() => onChange(selected ? null : card.role)}
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
                {card.icon}
              </span>
              <span className="text-sm font-semibold text-[var(--color-text-primary)]">
                {t(card.titleKey)}
              </span>
              <span className="text-xs leading-snug text-[var(--color-text-secondary)]">
                {t(card.taglineKey)}
              </span>
              <span className="mt-1 border-t border-[var(--color-border-separator)] pt-1.5 text-[11px] text-[var(--color-text-tertiary)]">
                {t(card.worksWithKey)}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
