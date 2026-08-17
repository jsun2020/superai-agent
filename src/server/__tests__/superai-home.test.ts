import { describe, expect, test } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  ensureSuperaiHome,
  getSuperaiHome,
  SUPERAI_HOME_ENV,
} from '../services/superaiHome.js'
import { useTempSuperaiHome } from './fixtures/tempSuperaiHome'

const home = useTempSuperaiHome()

describe('~/.superai location', () => {
  test('defaults to ~/.superai and honours SUPERAI_HOME', () => {
    // The fixture has already pointed the env at a temp dir.
    expect(getSuperaiHome()).toBe(home.dir)

    const saved = process.env[SUPERAI_HOME_ENV]
    delete process.env[SUPERAI_HOME_ENV]
    try {
      expect(getSuperaiHome()).toBe(path.join(os.homedir(), '.superai'))
      // It is NOT under ~/.claude: that folder is shared with Claude Code
      // and this one is ours alone.
      expect(getSuperaiHome()).not.toContain('.claude')
    } finally {
      process.env[SUPERAI_HOME_ENV] = saved
    }
  })
})

describe('seeding', () => {
  test('first run writes the README, the prompt, every role, every connector and the policy', () => {
    const result = ensureSuperaiHome(home.dir)
    const rel = (p: string) => path.relative(home.dir, p).split(path.sep).join('/')

    expect(result.written.map(rel).sort()).toEqual(
      [
        'README.md',
        'work-mode.md',
        'roles/assistant.md',
        'roles/sales.md',
        'roles/analyst.md',
        'connectors/feishu.json',
        'connectors/microsoft365.json',
        'connectors/slack.json',
        'connectors/notion.json',
        'connectors/google-workspace.json',
        'connectors/hubspot.json',
        'outbound-policy.json',
      ].sort(),
    )
    expect(result.skipped).toEqual([])
    expect(fs.existsSync(path.join(home.dir, '.runtime'))).toBe(true)
  })

  test('is idempotent: a second run writes nothing', () => {
    ensureSuperaiHome(home.dir)
    const second = ensureSuperaiHome(home.dir)
    expect(second.written).toEqual([])
    expect(second.skipped.length).toBeGreaterThan(0)
  })

  test('never overwrites a file the user has edited', () => {
    ensureSuperaiHome(home.dir)
    const salesPath = path.join(home.dir, 'roles', 'sales.md')
    fs.writeFileSync(salesPath, 'USER EDIT\n', 'utf-8')

    ensureSuperaiHome(home.dir)

    expect(fs.readFileSync(salesPath, 'utf-8')).toBe('USER EDIT\n')
  })

  test('a deleted file comes back on the next run (that is the documented reset)', () => {
    ensureSuperaiHome(home.dir)
    const salesPath = path.join(home.dir, 'roles', 'sales.md')
    fs.rmSync(salesPath)

    const result = ensureSuperaiHome(home.dir)

    expect(result.written).toEqual([salesPath])
    expect(fs.readFileSync(salesPath, 'utf-8')).toContain('Never invent a price')
  })

  test('the README explains what the user can do', () => {
    ensureSuperaiHome(home.dir)
    const readme = fs.readFileSync(path.join(home.dir, 'README.md'), 'utf-8')
    for (const marker of [
      'roles/<id>.md',
      'connectors/<id>.json',
      'outbound-policy.json',
      'disabled: true',
      '{{key}}',
      'Delete a file and restart',
    ]) {
      expect(readme).toContain(marker)
    }
  })
})
