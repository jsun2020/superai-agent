/**
 * ~/.superai — the product's own configuration folder.
 *
 * SuperAI Agent deliberately shares ~/.claude with Claude Code (sessions,
 * settings, agents, MCP config). Everything that is specific to THIS product
 * and meant to be edited by the user lives here instead, so it can be found,
 * backed up, or wiped as one folder:
 *
 *   ~/.superai/
 *     README.md              what each file is for
 *     work-mode.md           base Work-mode prompt
 *     roles/<id>.md          workplace roles (frontmatter + prompt body)
 *     connectors/<id>.json   one-click MCP connectors for the catalog
 *     outbound-policy.json   verbs that force an approval prompt in Work mode
 *     .runtime/              generated files; safe to delete
 *
 * Seeding rule: a built-in file is written ONLY if it does not exist, so a
 * user's edits are never overwritten by an upgrade. The flip side, stated
 * plainly in the README: an upgrade's new defaults only land in a file the
 * user has deleted. Delete + restart = reset to shipped.
 *
 * SUPERAI_HOME overrides the location (tests use this; it mirrors
 * CLAUDE_CONFIG_DIR).
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  BUILT_IN_CONNECTORS,
  BUILT_IN_OUTBOUND_VERBS,
  BUILT_IN_ROLES,
  BUILT_IN_WORK_MODE_PROMPT,
  serializeRoleFile,
} from './workplaceDefaults.js'

export const SUPERAI_HOME_ENV = 'SUPERAI_HOME'

export function getSuperaiHome(): string {
  const override = process.env[SUPERAI_HOME_ENV]?.trim()
  return override ? path.resolve(override) : path.join(os.homedir(), '.superai')
}

export function getRolesDir(): string {
  return path.join(getSuperaiHome(), 'roles')
}

export function getConnectorsDir(): string {
  return path.join(getSuperaiHome(), 'connectors')
}

export function getWorkModePromptPath(): string {
  return path.join(getSuperaiHome(), 'work-mode.md')
}

export function getOutboundPolicyPath(): string {
  return path.join(getSuperaiHome(), 'outbound-policy.json')
}

/** Generated, non-user files. Safe to delete at any time. */
export function getRuntimeDir(): string {
  return path.join(getSuperaiHome(), '.runtime')
}

const README = `# SuperAI Agent - your configuration folder

Everything in this folder is yours to edit. SuperAI Agent reads these files
fresh each time it needs them, so changes take effect on the next new session
(no restart needed) - except where noted.

  work-mode.md           The base prompt every Work-mode session starts from.
  roles/<id>.md          One file per role card on the "new session" screen.
  connectors/<id>.json   One file per card in Settings > Connectors.
  outbound-policy.json   Tool-name verbs that force an approval prompt in
                         Work mode (send, delete, ...). Applies to new sessions.
  .runtime/              Generated files. Safe to delete.

## Roles (roles/<id>.md)

The filename is the role id: roles/recruiter.md creates a "recruiter" role.
Ids: lowercase letters, digits and dashes.

    ---
    name: Recruiter
    name_zh: 招聘专员
    icon: person_search          # any Material Symbols icon name
    tagline: Screens CVs and drafts outreach that sounds like you.
    tagline_zh: ...
    worksWith: Email - Calendar - ATS
    worksWith_zh: ...
    examples:
      - Screen these CVs against the job description
      - Draft an outreach message to this candidate
    examples_zh:
      - ...
    # disabled: true            # hide this role without deleting the file
    ---
    The user has chosen the Recruiter role. ...
    - Draft, never send. Before any outbound message ...

The body below the frontmatter is appended to the Work-mode prompt when the
role is picked. Keep it short and put the single most important rule in it.
Any field can carry a _zh (or other locale) variant; the English one is the
fallback. If a role should delegate to a subagent, create that subagent in
~/.claude/agents/<name>.md and name it in the prompt.

## Connectors (connectors/<id>.json)

    {
      "id": "slack",
      "serverName": "slack",
      "icon": "tag",
      "name": { "en": "Slack", "zh": "Slack" },
      "description": { "en": "...", "zh": "..." },
      "worksWith": { "en": "Channels - Threads", "zh": "..." },
      "provenance": "community",          // or "official"
      "packageName": "@some/mcp-server",
      "docsUrl": "https://...",
      "status": "available",              // or "coming-soon"
      "fields": [
        { "key": "token", "type": "password", "label": { "en": "Bot token" }, "required": true },
        { "key": "readOnly", "type": "checkbox", "label": { "en": "Read-only" }, "defaultValue": true }
      ],
      "config": {
        "type": "stdio",
        "command": "npx",
        "args": [ "-y", "@some/mcp-server", "--token", "{{token}}",
                  { "if": "readOnly", "then": ["--read-only"] } ],
        "env": {}
      }
    }

Field types: text, password, select (needs "options" and "defaultValue"),
checkbox (needs "defaultValue"). In "config", "{{key}}" is replaced by the
field's value; { "if": "key", "then": [...] } adds those args when the field
is non-empty / checked, and { "unless": "key", "then": [...] } when it is not.
"disabled": true hides a connector.

## Resetting

Delete a file and restart: the shipped version is written back. That is also
how an upgrade's new defaults reach you - a file you have edited is never
overwritten.
`

/**
 * Read a user-editable text file the way Windows editors actually write them:
 * strip a UTF-8 BOM (Notepad, many IDEs) and normalise CRLF to LF, so the
 * frontmatter regex, JSON.parse and prompt bodies all see the same bytes a
 * Unix-authored file would produce. (LL-002: always normalise CRLF before
 * regex work on Windows.)
 */
export function readUserTextFile(filePath: string): string {
  return normalizeUserText(fs.readFileSync(filePath, 'utf-8'))
}

/** Pure form of readUserTextFile's cleanup, for text already in memory. */
export function normalizeUserText(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

export type SeedResult = { written: string[]; skipped: string[] }

/**
 * Create the folder and write every built-in file that is missing.
 * Idempotent and cheap when nothing is missing. Never overwrites.
 */
export function ensureSuperaiHome(home: string = getSuperaiHome()): SeedResult {
  const result: SeedResult = { written: [], skipped: [] }

  fs.mkdirSync(path.join(home, 'roles'), { recursive: true })
  fs.mkdirSync(path.join(home, 'connectors'), { recursive: true })
  fs.mkdirSync(path.join(home, '.runtime'), { recursive: true })

  const seed = (rel: string, content: string) => {
    const target = path.join(home, rel)
    if (fs.existsSync(target)) {
      result.skipped.push(target)
      return
    }
    fs.writeFileSync(target, content, 'utf-8')
    result.written.push(target)
  }

  seed('README.md', README)
  seed('work-mode.md', BUILT_IN_WORK_MODE_PROMPT + '\n')
  for (const role of BUILT_IN_ROLES) {
    seed(path.join('roles', `${role.id}.md`), serializeRoleFile(role))
  }
  for (const connector of BUILT_IN_CONNECTORS) {
    seed(
      path.join('connectors', `${connector.id}.json`),
      JSON.stringify(connector, null, 2) + '\n',
    )
  }
  seed(
    'outbound-policy.json',
    JSON.stringify({ verbs: [...BUILT_IN_OUTBOUND_VERBS] }, null, 2) + '\n',
  )

  return result
}

let ensuredFor: string | null = null

/**
 * Seed once per process per home path. Loaders call this so the folder exists
 * even when the server entrypoint did not run (CLI paths, tests).
 */
export function ensureSuperaiHomeOnce(): void {
  const home = getSuperaiHome()
  if (ensuredFor === home) return
  try {
    ensureSuperaiHome(home)
    ensuredFor = home
  } catch (error) {
    // A read-only or missing home directory must not take the product down;
    // every loader falls back to the built-ins. Logged, not swallowed.
    console.error(`[SuperaiHome] Could not create ${home}:`, error)
  }
}

/** Test hook: forget that a home was seeded (e.g. after switching SUPERAI_HOME). */
export function resetSuperaiHomeSeedState(): void {
  ensuredFor = null
}
