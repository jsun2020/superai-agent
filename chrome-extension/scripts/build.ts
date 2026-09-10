/**
 * Build the extension into dist/ ready for "Load unpacked":
 *   1. Bun.build: background (ES module worker), content + page hook (classic IIFE scripts)
 *   2. vite build: the side panel page (React)
 *   3. copy manifest.json; move sidepanel/index.html to dist/sidepanel.html
 */
import { rm, mkdir, copyFile, rename, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dir, '..')
const dist = path.join(root, 'dist')

await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })

async function bundle(entry: string, outName: string, format: 'esm' | 'iife') {
  const result = await Bun.build({
    entrypoints: [path.join(root, 'src', entry)],
    outdir: dist,
    naming: outName,
    target: 'browser',
    format,
    minify: false,
    sourcemap: 'none',
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error(`bundle failed: ${entry}`)
  }
}

await bundle('background.ts', 'background.js', 'esm')
await bundle('content.ts', 'content.js', 'iife')
await bundle('page-hook.ts', 'page-hook.js', 'iife')

const vite = Bun.spawn(['bunx', 'vite', 'build'], { cwd: root, stdout: 'inherit', stderr: 'inherit' })
if ((await vite.exited) !== 0) throw new Error('vite build failed')

// Vite writes <root>/index.html relative to its root; flatten to dist/sidepanel.html.
const nested = path.join(dist, 'index.html')
if (existsSync(nested)) await rename(nested, path.join(dist, 'sidepanel.html'))
await copyFile(path.join(root, 'manifest.json'), path.join(dist, 'manifest.json'))

const files = (await readdir(dist, { recursive: true })).filter((f) => !f.endsWith(path.sep))
console.log(`[chrome-extension] built ${files.length} files into ${dist}:`)
for (const f of files) console.log('  ' + f)
