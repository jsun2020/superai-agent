// Source: src/server/services/workplaceDefaults.ts, src/server/api/work.ts
//
// The Work-mode catalog — roles and connectors — is a set of files in
// ~/.superai served by the local server. The desktop renders whatever the
// server returns; it ships no catalog of its own.

/**
 * A plain string is "the same in every language"; an object maps locale codes
 * to text with `en` as the fallback. See pickLocalized().
 */
export type LocalizedText = string | { en?: string; [locale: string]: string | undefined }

export type WorkRole = {
  id: string
  icon: string
  name: LocalizedText
  tagline: LocalizedText
  worksWith: LocalizedText
  examples: LocalizedText[]
  source: 'built-in' | 'file'
  path?: string
}

export type ConnectorFieldValue = string | boolean

export type ConnectorField =
  | {
      key: string
      type: 'text' | 'password'
      label: LocalizedText
      required?: boolean
      placeholder?: string
      hint?: LocalizedText
    }
  | {
      key: string
      type: 'select'
      label: LocalizedText
      defaultValue: string
      options: ReadonlyArray<{ value: string; label: LocalizedText }>
      hint?: LocalizedText
    }
  | {
      key: string
      type: 'checkbox'
      label: LocalizedText
      defaultValue: boolean
      hint?: LocalizedText
    }

export type Connector = {
  id: string
  /** Default MCP server name; the user can rename before connecting. */
  serverName: string
  icon: string
  name: LocalizedText
  description: LocalizedText
  worksWith: LocalizedText
  provenance: 'official' | 'community'
  packageName?: string
  docsUrl?: string
  status: 'available' | 'coming-soon'
  fields: readonly ConnectorField[]
  securityNote?: LocalizedText
  postConnectHint?: LocalizedText
  source: 'built-in' | 'file'
  path?: string
}
