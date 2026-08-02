import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string) => {
    const translations: Record<string, string> = {
      'empty.rolePickerLabel': 'Pick a role, or just describe your task',
      'role.assistant': 'Assistant',
      'role.assistantTagline': 'Triages the inbox.',
      'role.assistantWorksWith': 'Email - Calendar',
      'role.sales': 'Sales',
      'role.salesTagline': 'Researches accounts.',
      'role.salesWorksWith': 'CRM - Email',
      'role.analyst': 'Analyst',
      'role.analystTagline': 'Turns spreadsheets into a finding.',
      'role.analystWorksWith': 'Excel - Reports',
    }
    return translations[key] ?? key
  },
}))

import { RoleCards, ROLE_CARDS, ROLE_EXAMPLE_KEYS } from './RoleCards'
import { SESSION_ROLES } from '../../types/settings'

describe('RoleCards', () => {
  it('renders one card per shipped role with its job and works-with line', () => {
    render(<RoleCards value={null} onChange={() => {}} />)

    for (const label of ['Assistant', 'Sales', 'Analyst']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(screen.getByText('Triages the inbox.')).toBeInTheDocument()
    expect(screen.getByText('CRM - Email')).toBeInTheDocument()
    expect(screen.getByTestId('work-mode-roles')).toBeInTheDocument()
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

  it('stays in sync with the shared SessionRole list', () => {
    // A role added to the type but not to the cards would ship an option the
    // backend accepts and the UI never offers.
    expect(ROLE_CARDS.map((card) => card.role)).toEqual([...SESSION_ROLES])
    for (const role of SESSION_ROLES) {
      expect(ROLE_EXAMPLE_KEYS[role].length).toBeGreaterThan(0)
    }
  })
})
