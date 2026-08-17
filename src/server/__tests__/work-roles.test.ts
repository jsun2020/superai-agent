import { describe, expect, test } from 'bun:test'
import * as fs from 'fs'
import * as path from 'path'

import { pickLocalized } from '../services/localized.js'
import { buildModeCliArgs, WORK_MODE_PROMPT } from '../services/workMode.js'
import {
  findWorkRole,
  loadWorkModePrompt,
  loadWorkRoles,
  parseRoleSource,
} from '../services/workRoles.js'
import { BUILT_IN_ROLES, serializeRoleFile } from '../services/workplaceDefaults.js'
import { useTempSuperaiHome } from './fixtures/tempSuperaiHome'

const home = useTempSuperaiHome()

const roleFile = (id: string) => path.join(home.dir, 'roles', `${id}.md`)
const writeRole = (id: string, text: string) => {
  fs.mkdirSync(path.dirname(roleFile(id)), { recursive: true })
  fs.writeFileSync(roleFile(id), text, 'utf-8')
}

describe('seed round-trip', () => {
  test('every built-in role survives serialize -> parse byte-for-byte on the fields that matter', () => {
    // The seeds are what users copy from. If the writer and the reader
    // disagreed, the shipped files would silently differ from the compiled
    // defaults on the very first launch.
    for (const role of BUILT_IN_ROLES) {
      const parsed = parseRoleSource(serializeRoleFile(role), `${role.id}.md`, role.id)
      expect(parsed).not.toBeNull()
      expect(parsed!.prompt).toBe(role.prompt)
      expect(parsed!.icon).toBe(role.icon)
      expect(parsed!.name).toEqual(role.name)
      expect(parsed!.tagline).toEqual(role.tagline)
      expect(parsed!.worksWith).toEqual(role.worksWith)
      expect(parsed!.examples).toEqual(role.examples)
    }
  })

  test('the freshly seeded folder yields the built-ins, in order, marked as files', () => {
    const roles = loadWorkRoles()
    expect(roles.map((r) => r.id)).toEqual(['assistant', 'sales', 'analyst'])
    // They come from disk now, which is the point: editing them is supported.
    for (const role of roles) {
      expect(role.source).toBe('file')
      expect(role.path).toBe(roleFile(role.id))
    }
    expect(roles.map((r) => r.prompt)).toEqual(BUILT_IN_ROLES.map((r) => r.prompt))
  })
})

describe('user-defined roles', () => {
  test('a new file adds a role after the built-ins', () => {
    writeRole(
      'recruiter',
      [
        '---',
        'name: Recruiter',
        'name_zh: 招聘专员',
        'icon: person_search',
        'tagline: Screens CVs.',
        'worksWith: Email - ATS',
        'examples:',
        '  - Screen these CVs',
        '  - Draft outreach',
        'examples_zh:',
        '  - 筛选简历',
        '---',
        'The user has chosen the Recruiter role.',
        '- Draft, never send.',
        '',
      ].join('\n'),
    )

    const roles = loadWorkRoles()
    expect(roles.map((r) => r.id)).toEqual(['assistant', 'sales', 'analyst', 'recruiter'])

    const recruiter = findWorkRole('recruiter')!
    expect(recruiter.source).toBe('file')
    expect(pickLocalized(recruiter.name, 'en')).toBe('Recruiter')
    expect(pickLocalized(recruiter.name, 'zh')).toBe('招聘专员')
    expect(recruiter.icon).toBe('person_search')
    // Uneven example lists zip by index and fall back to English.
    expect(recruiter.examples).toEqual([
      { en: 'Screen these CVs', zh: '筛选简历' },
      { en: 'Draft outreach' },
    ])
    expect(pickLocalized(recruiter.examples[1], 'zh')).toBe('Draft outreach')
    expect(recruiter.prompt).toBe('The user has chosen the Recruiter role.\n- Draft, never send.')
  })

  test('the new role reaches the CLI args exactly like a built-in', () => {
    writeRole('recruiter', '---\nname: Recruiter\n---\nRECRUITER PROMPT\n')
    expect(buildModeCliArgs('work', 'recruiter')).toEqual([
      '--append-system-prompt',
      `${WORK_MODE_PROMPT}\n\nRECRUITER PROMPT`,
    ])
  })

  test('a file with a built-in id overrides only the fields it sets', () => {
    // A one-line file that changes just the prompt is the common case.
    writeRole('sales', 'CUSTOM SALES PROMPT\n')

    const sales = findWorkRole('sales')!
    expect(sales.prompt).toBe('CUSTOM SALES PROMPT')
    // Everything else is still the built-in.
    expect(sales.icon).toBe('trending_up')
    expect(pickLocalized(sales.name, 'zh')).toBe('销售')
    expect(sales.examples).toEqual(BUILT_IN_ROLES[1]!.examples)
    expect(buildModeCliArgs('work', 'sales')[1]).toBe(`${WORK_MODE_PROMPT}\n\nCUSTOM SALES PROMPT`)
  })

  test('disabled: true hides a role, built-in or not', () => {
    writeRole('sales', '---\ndisabled: true\n---\n')
    writeRole('recruiter', '---\nname: R\ndisabled: true\n---\nP\n')

    expect(loadWorkRoles().map((r) => r.id)).toEqual(['assistant', 'analyst'])
    expect(findWorkRole('sales')).toBeUndefined()
    // A hidden role degrades to plain Work mode, never throws.
    expect(buildModeCliArgs('work', 'sales')).toEqual(['--append-system-prompt', WORK_MODE_PROMPT])
  })

  test('deleting a built-in file falls back to the compiled default rather than losing the role', () => {
    loadWorkRoles() // seeds the folder
    fs.rmSync(roleFile('analyst'))
    const analyst = findWorkRole('analyst')!
    expect(analyst.source).toBe('built-in')
    expect(analyst.prompt).toBe(BUILT_IN_ROLES[2]!.prompt)
  })
})

describe('bad input never takes a role away', () => {
  test('a new-role file without a name or a prompt is ignored, loudly', () => {
    const errors: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '))
    try {
      writeRole('nameless', 'just a prompt, no frontmatter\n')
      writeRole('promptless', '---\nname: No Prompt\n---\n')
      expect(loadWorkRoles().map((r) => r.id)).toEqual(['assistant', 'sales', 'analyst'])
      expect(errors.some((e) => e.includes('nameless.md'))).toBe(true)
      expect(errors.some((e) => e.includes('promptless.md'))).toBe(true)
    } finally {
      console.error = original
    }
  })

  test('a filename that is not a valid id is ignored', () => {
    const original = console.error
    console.error = () => {}
    try {
      writeRole('Bad Name', '---\nname: x\n---\np\n')
      writeRole('UPPER', '---\nname: x\n---\np\n')
      expect(loadWorkRoles().map((r) => r.id)).toEqual(['assistant', 'sales', 'analyst'])
    } finally {
      console.error = original
    }
  })

  test('findWorkRole refuses ids that could be paths', () => {
    expect(findWorkRole('../etc/passwd')).toBeUndefined()
    expect(findWorkRole('sales/../analyst')).toBeUndefined()
    expect(findWorkRole(42)).toBeUndefined()
    expect(findWorkRole(null)).toBeUndefined()
  })
})

describe('work-mode.md', () => {
  test('is the seeded copy of the built-in prompt', () => {
    expect(loadWorkModePrompt()).toBe(WORK_MODE_PROMPT)
  })

  test('an edited base prompt reaches every Work session', () => {
    fs.writeFileSync(path.join(home.dir, 'work-mode.md'), '---\n# a comment header\n---\nMY BASE\n')
    expect(buildModeCliArgs('work')).toEqual(['--append-system-prompt', 'MY BASE'])
    expect(buildModeCliArgs('work', 'sales')[1]!.startsWith('MY BASE\n\n')).toBe(true)
  })

  test('an emptied file falls back to the built-in rather than sending nothing', () => {
    fs.writeFileSync(path.join(home.dir, 'work-mode.md'), '\n\n')
    expect(loadWorkModePrompt()).toBe(WORK_MODE_PROMPT)
  })
})

describe('files as Windows editors write them', () => {
  // Found by the first E2E against the shipped binary: a role file written by
  // PowerShell (BOM + CRLF) was silently ignored because the frontmatter regex
  // never matched past the BOM. LL-002 in a new costume.
  const BOM = '\uFEFF'
  const crlf = (s: string) => s.replace(/\n/g, '\r\n')

  test('a role file with a UTF-8 BOM and CRLF line endings loads exactly like a clean one', () => {
    const clean = '---\nname: Recruiter\nname_zh: 招聘专员\nexamples:\n  - One\n  - Two\n---\nLine one.\n- Line two.\n'
    writeRole('recruiter', BOM + crlf(clean))

    const recruiter = findWorkRole('recruiter')!
    expect(recruiter).toBeDefined()
    expect(pickLocalized(recruiter.name, 'zh')).toBe('招聘专员')
    expect(recruiter.examples).toEqual([{ en: 'One' }, { en: 'Two' }])
    // No stray \r inside the prompt that goes to the CLI.
    expect(recruiter.prompt).toBe('Line one.\n- Line two.')
    expect(recruiter.prompt).not.toContain('\r')
  })

  test('work-mode.md with a BOM and CRLF yields a clean prompt', () => {
    fs.writeFileSync(path.join(home.dir, 'work-mode.md'), BOM + crlf('BASE\n- rule\n'), 'utf-8')
    expect(loadWorkModePrompt()).toBe('BASE\n- rule')
  })
})
