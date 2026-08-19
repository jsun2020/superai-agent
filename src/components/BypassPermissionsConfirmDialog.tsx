import React from 'react'
import { logEvent } from 'src/services/analytics/index.js'
import { Box, Link, Newline, Text } from '../ink.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'

type Props = {
  onAccept(): void
  onDecline(): void
}

/**
 * Shown the first time a session cycles INTO "bypass permissions" with
 * Shift+Tab (SuperAI puts that mode in the cycle by default). Same warning
 * text as the startup `BypassPermissionsModeDialog`, but declining keeps the
 * session alive: it reverts to the previous mode and drops bypass from the
 * cycle for the rest of the session. Accepting persists
 * `skipDangerousModePermissionPrompt`, so it is asked once per machine.
 */
export function BypassPermissionsConfirmDialog({ onAccept, onDecline }: Props): React.ReactNode {
  React.useEffect(() => {
    logEvent('tengu_bypass_permissions_cycle_dialog_shown', {})
  }, [])

  const onChange = (value: 'accept' | 'decline') => {
    if (value === 'accept') {
      logEvent('tengu_bypass_permissions_cycle_dialog_accept', {})
      updateSettingsForSource('userSettings', { skipDangerousModePermissionPrompt: true })
      onAccept()
    } else {
      logEvent('tengu_bypass_permissions_cycle_dialog_decline', {})
      onDecline()
    }
  }

  return (
    <Dialog title="WARNING: switching to Bypass Permissions mode" color="error" onCancel={onDecline}>
      <Box flexDirection="column" gap={1}>
        <Text>
          In Bypass Permissions mode, the agent will not ask for your approval before running potentially dangerous commands.
          <Newline />
          This mode should only be used in a sandboxed container/VM that has restricted internet access and can easily be restored if damaged.
        </Text>
        <Text>By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.</Text>
        <Link url="https://code.claude.com/docs/en/security" />
      </Box>
      <Select
        options={[
          { label: 'No, stay in the current mode', value: 'decline' },
          { label: 'Yes, I accept', value: 'accept' },
        ]}
        onChange={value => onChange(value as 'accept' | 'decline')}
      />
    </Dialog>
  )
}
