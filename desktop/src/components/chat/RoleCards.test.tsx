import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string) => {
    const translations: Record<string, string> = {
      'empty.rolePickerLabel': 'Pick a role, or just describe your task',
    }
    return translations[key] ?? key
  },
}))

import { RoleCards } from './RoleCards'
import { useSettingsStore } from '../../stores/settingsStore'
import { useWorkStore } from '../../stores/workStore'
import type { WorkRole } from '../../types/work'

/** What GET /api/work/roles returns for a freshly seeded ~/.superai. */
const SEEDED_ROLES: WorkRole[] = [
  {
    id: 'assistant',
    icon: 'event_available',
    name: { en: 'Assistant', zh: '助理' },
    tagline: { en: 'Triages the inbox.', zh: '整理收件箱。' },
    worksWith: { en: 'Email - Calendar', zh: '邮件 - 日历' },
    examples: [{ en: 'Triage my inbox', zh: '整理收件箱' }],
    source: 'file',
  },
  {
    id: 'sales',
    icon: 'trending_up',
    name: { en: 'Sales', zh: '销售' },
    tagline: { en: 'Researches accounts.', zh: '调研客户。' },
    worksWith: { en: 'CRM - Email', zh: 'CRM - 邮件' },
    examples: [{ en: 'Research this account' }],
    source: 'file',
  },
  {
    id: 'analyst',
    icon: 'insights',
    name: { en: 'Analyst', zh: '分析师' },
    tagline: { en: 'Turns spreadsheets into a finding.', zh: '把表格变成结论。' },
    worksWith: { en: 'Excel - Reports', zh: 'Excel - 报表' },
    examples: [{ en: 'Analyze this spreadsheet' }],
    source: 'file',
  },
]

const fetchRoles = vi.fn()

function seedStore(roles: WorkRole[], loaded = true) {
  useWorkStore.setState({ roles, rolesLoaded: loaded, fetchRoles } as Partial<
    ReturnType<typeof useWorkStore.getState>
  >)
}

describe('RoleCards', () => {
  beforeEach(() => {
    fetchRoles.mockReset()
    fetchRoles.mockResolvedValue(undefined)
    useSettingsStore.setState({ locale: 'en' } as Partial<ReturnType<typeof useSettingsStore.getState>>)
    seedStore(SEEDED_ROLES)
  })

  it('asks the server for the catalog on mount', () => {
    render(<RoleCards value={null} onChange={() => {}} />)
    expect(fetchRoles).toHaveBeenCalledTimes(1)
  })

  it('renders one card per role the server returned, with its job and works-with line', () => {
    render(<RoleCards value={null} onChange={() => {}} />)

    for (const label of ['Assistant', 'Sales', 'Analyst']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(screen.getByText('Triages the inbox.')).toBeInTheDocument()
    expect(screen.getByText('CRM - Email')).toBeInTheDocument()
    expect(screen.getByTestId('work-mode-roles')).toBeInTheDocument()
  })

  it('renders in the current locale, falling back to English', () => {
    useSettingsStore.setState({ locale: 'zh' } as Partial<ReturnType<typeof useSettingsStore.getState>>)
    render(<RoleCards value={null} onChange={() => {}} />)

    expect(screen.getByText('销售')).toBeInTheDocument()
    expect(screen.getByText('把表格变成结论。')).toBeInTheDocument()
  })

  it('shows a role the user added as a file, with no code change', () => {
    // The whole point of ~/.superai/roles: a new file is a new card.
    seedStore([
      ...SEEDED_ROLES,
      {
        id: 'recruiter',
        icon: 'person_search',
        name: 'Recruiter',
        tagline: 'Screens CVs.',
        worksWith: 'Email - ATS',
        examples: [],
        source: 'file',
        path: '/home/x/.superai/roles/recruiter.md',
      },
    ])
    const onChange = vi.fn()
    render(<RoleCards value={null} onChange={onChange} />)

    expect(screen.getByText('Recruiter')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('role-card-recruiter'))
    expect(onChange).toHaveBeenCalledWith('recruiter')
  })

  it('reports the picked role to the parent', () => {
    const onChange = vi.fn()
    render(<RoleCards value={null} onChange={onChange} />)

    fireEvent.click(screen.getByTestId('role-card-sales'))

    expect(onChange).toHaveBeenCalledWith('sales')
  })

  it('clicking the selected card clears the role', () => {
    // Deselecting must be reachable: with no role the session falls back to
    // the plain document experience, and there is no other way back to it.
    const onChange = vi.fn()
    render(<RoleCards value="analyst" onChange={onChange} />)

    fireEvent.click(screen.getByTestId('role-card-analyst'))

    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('marks only the selected card as pressed', () => {
    render(<RoleCards value="assistant" onChange={() => {}} />)

    expect(screen.getByTestId('role-card-assistant')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('role-card-sales')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('role-card-analyst')).toHaveAttribute('aria-pressed', 'false')
  })

  it('renders nothing when the catalog is empty (every role disabled)', () => {
    seedStore([])
    render(<RoleCards value={null} onChange={() => {}} />)
    expect(screen.queryByTestId('work-mode-roles')).not.toBeInTheDocument()
  })

  it('keeps the label while the first fetch is still in flight', () => {
    // Not-yet-loaded is not the same as empty: no flash of "no roles".
    seedStore([], false)
    render(<RoleCards value={null} onChange={() => {}} />)
    expect(screen.getByTestId('work-mode-roles')).toBeInTheDocument()
  })
})
