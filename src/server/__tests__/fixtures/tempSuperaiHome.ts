import { afterEach, beforeEach } from 'bun:test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  SUPERAI_HOME_ENV,
  resetSuperaiHomeSeedState,
} from '../../services/superaiHome.js'

/**
 * Point SUPERAI_HOME at a fresh temp folder for every test in the calling
 * file, and put the previous value back afterwards.
 *
 * Without this, tests read the developer's real ~/.superai — and pass or fail
 * depending on what that person last edited (LL-041: a suite that does not
 * own its environment). process.env is shared process-wide, so the value is
 * restored, not deleted blindly.
 */
export function useTempSuperaiHome(): { readonly dir: string } {
  let previous: string | undefined
  let dir = ''

  beforeEach(() => {
    previous = process.env[SUPERAI_HOME_ENV]
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superai-home-'))
    process.env[SUPERAI_HOME_ENV] = dir
    resetSuperaiHomeSeedState()
  })

  afterEach(() => {
    if (previous === undefined) delete process.env[SUPERAI_HOME_ENV]
    else process.env[SUPERAI_HOME_ENV] = previous
    resetSuperaiHomeSeedState()
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })

  return {
    get dir() {
      return dir
    },
  }
}
