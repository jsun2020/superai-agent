import * as React from 'react'
import { useState } from 'react'
import type { LocalJSXCommandContext } from '../../commands.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { SuperaiProviderSetup } from '../../components/SuperaiProviderSetup.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { stripSignatureBlocks } from '../../utils/messages.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return (
    <ProviderDialog
      onDone={configured => {
        if (configured) {
          // Same post-auth-change hygiene as /login: the API key changed, and
          // signature-bearing blocks are bound to the old key.
          context.onChangeAPIKey()
          context.setMessages(stripSignatureBlocks)
          // The new provider's env is already in process.env; make the
          // session's model follow it (its ANTHROPIC_MODEL, else the default
          // that now resolves through ANTHROPIC_DEFAULT_*_MODEL).
          const model = process.env.ANTHROPIC_MODEL || null
          context.setAppState(prev => ({
            ...prev,
            mainLoopModel: model,
            mainLoopModelForSession: null,
            authVersion: prev.authVersion + 1,
          }))
          const where = process.env.ANTHROPIC_BASE_URL
          onDone(`Provider configured${where ? ` (${where})` : ''}`)
        } else {
          onDone('Provider setup cancelled')
        }
      }}
    />
  )
}

function ProviderDialog({ onDone }: { onDone: (configured: boolean) => void }): React.ReactNode {
  const [editing, setEditing] = useState(false)
  return (
    <Dialog
      title="Model provider"
      color="permission"
      onCancel={() => onDone(false)}
      isCancelActive={!editing}
    >
      <SuperaiProviderSetup onDone={() => onDone(true)} onEditingChange={setEditing} />
    </Dialog>
  )
}
