/**
 * Standalone TUI entrypoint for the portable build.
 *
 * Compiled by build-sidecars.ts into `superai-agent-tui-<triple>.exe`. Unlike
 * `superai-agent-sidecar.ts` this binary has no mode argument — running it directly
 * (or double-clicking from a console) drops the user straight into the Ink
 * TUI, exactly like `bin/superai-agent` does in source form.
 *
 * The portable build script ships this binary as `superai-agent-tui.exe`
 * alongside the Tauri Desktop window, so a user who prefers the terminal
 * experience never has to install Bun.
 */

import { registerVendorBinDir } from '../../src/utils/vendorBinDir'

// Portable builds stage third-party tool binaries (officecli.exe) in a
// vendor/ folder next to this exe; put it on PATH before anything spawns.
registerVendorBinDir()

process.env.CALLER_DIR ||= process.cwd()

// preload sets up the same shimmed `ant-internal` modules that the merged
// sidecar relies on; required because the Ink TUI imports them transitively.
await import('../../preload.ts')
await import('../../src/entrypoints/cli.tsx')
