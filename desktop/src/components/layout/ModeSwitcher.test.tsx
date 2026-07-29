import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string) => {
    const translations: Record<string, string> = {
      'mode.work': 'Work',
      'mode.code': 'Code',
      'mode.workDescription': 'For getting work done',
      'mode.codeDescription': 'For developers',
      'mode.switcherLabel': 'Switch between Work and Code mode',
    }
    return translations[key] ?? key
  },
}))

import { ModeSwitcher } from './ModeSwitcher'
import { useUIStore } from '../../stores/uiStore'

describe('ModeSwitcher', () => {
  beforeEach(() => {
    localStorage.removeItem('superai-agent-app-mode')
    useUIStore.setState({ appMode: 'code' })
  })

  it('shows the current mode in the brand trigger (Code by default)', () => {
    render(<ModeSwitcher />)
    const trigger = screen.getByTestId('mode-switcher-trigger')
    expect(trigger).toHaveTextContent('SuperAI')
    expect(trigger).toHaveTextContent('Code')
  })

  it('switches to Work mode and persists the choice', () => {
    render(<ModeSwitcher />)
    fireEvent.click(screen.getByTestId('mode-switcher-trigger'))
    fireEvent.click(screen.getByText('For getting work done'))

    expect(useUIStore.getState().appMode).toBe('work')
    expect(localStorage.getItem('superai-agent-app-mode')).toBe('work')
    expect(screen.getByTestId('mode-switcher-trigger')).toHaveTextContent('Work')
  })

  it('offers both modes with their descriptions when opened', () => {
    render(<ModeSwitcher />)
    fireEvent.click(screen.getByTestId('mode-switcher-trigger'))

    expect(screen.getByText('For getting work done')).toBeInTheDocument()
    expect(screen.getByText('For developers')).toBeInTheDocument()
  })
})
