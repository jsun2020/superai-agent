import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'

const terminalMocks = vi.hoisted(() => ({
  available: true,
}))

vi.mock('../../api/terminal', () => ({
  terminalApi: {
    isAvailable: () => terminalMocks.available,
  },
}))

import { CodexOfficialLogin } from './CodexOfficialLogin'

describe('CodexOfficialLogin', () => {
  beforeEach(() => {
    terminalMocks.available = true
    useUIStore.setState({
      pendingSettingsTab: null,
      pendingTerminalCommand: null,
    })
    useSettingsStore.setState({ locale: 'en' })
  })

  it('starts a clean Codex re-login to replace invalidated ChatGPT tokens', () => {
    render(<CodexOfficialLogin />)

    fireEvent.click(screen.getByRole('button', { name: /Codex/ }))

    expect(useUIStore.getState().pendingTerminalCommand).toBe(
      'codex logout\ncodex login\n',
    )
    expect(useUIStore.getState().pendingSettingsTab).toBe('terminal')
  })

  it('shows an error when the built-in terminal is unavailable', () => {
    terminalMocks.available = false

    render(<CodexOfficialLogin />)

    fireEvent.click(screen.getByRole('button', { name: /Codex/ }))

    expect(screen.getByText(/packaged desktop app/i)).toBeInTheDocument()
    expect(useUIStore.getState().pendingTerminalCommand).toBeNull()
  })
})
