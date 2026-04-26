/**
 * Standalone TUI entrypoint for the portable build.
 *
 * Compiled by build-sidecars.ts into `claude-haha-tui-<triple>.exe`. Unlike
 * `claude-sidecar.ts` this binary has no mode argument — running it directly
 * (or double-clicking from a console) drops the user straight into the Ink
 * TUI, exactly like `bin/claude-haha` does in source form.
 *
 * The portable build script ships this binary as `claude-haha-tui.exe`
 * alongside the Tauri Desktop window, so a user who prefers the terminal
 * experience never has to install Bun.
 */

process.env.CALLER_DIR ||= process.cwd()

// preload sets up the same shimmed `ant-internal` modules that the merged
// sidecar relies on; required because the Ink TUI imports them transitively.
await import('../../preload.ts')
await import('../../src/entrypoints/cli.tsx')
