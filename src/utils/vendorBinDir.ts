import fs from 'node:fs'
import path from 'node:path'

/**
 * Portable builds ship third-party tool binaries in a `vendor/` folder next to
 * the compiled exe (e.g. vendor/officecli.exe, staged by
 * scripts/build-portable.ps1). Prepending that folder to PATH at process start
 * lets every spawned shell (agent Bash commands, adapters) find those tools
 * with zero user setup on machines that have nothing else installed.
 *
 * In dev (`bun run ...`) process.execPath is bun itself and no vendor dir
 * exists next to it, so this is a no-op.
 *
 * Returns the vendor dir that is now on PATH, or null when there is none.
 */
export function registerVendorBinDir(
  execPath: string = process.execPath,
  env: Record<string, string | undefined> = process.env,
): string | null {
  try {
    const vendorDir = path.join(path.dirname(execPath), 'vendor')
    if (!fs.existsSync(vendorDir)) return null
    const sep = process.platform === 'win32' ? ';' : ':'
    const current = env.PATH ?? ''
    const alreadyPresent = current
      .split(sep)
      .filter(Boolean)
      .some((entry) =>
        process.platform === 'win32'
          ? entry.toLowerCase() === vendorDir.toLowerCase()
          : entry === vendorDir,
      )
    if (!alreadyPresent) {
      env.PATH = current ? `${vendorDir}${sep}${current}` : vendorDir
    }
    return vendorDir
  } catch {
    // PATH augmentation is best-effort: a failure here must never stop the
    // app from starting - the office agent falls back to its Python toolbelt.
    return null
  }
}
