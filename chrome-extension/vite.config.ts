import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Builds only the side panel page. background.js, content.js and page-hook.js
// are bundled separately by scripts/build.ts (Bun.build), because content
// scripts must be classic scripts and the worker is an ES module.
export default defineConfig({
  root: path.resolve(__dirname, 'src/sidepanel'),
  base: './',
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: false,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/sidepanel/index.html'),
      output: {
        entryFileNames: 'sidepanel.js',
        assetFileNames: 'assets/[name][extname]',
        chunkFileNames: 'assets/[name].js',
      },
    },
  },
})
