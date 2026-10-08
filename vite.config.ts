import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // GitHub Pages serves the site from https://flemm0.github.io/sql-execution-visualizer/
  base: '/sql-execution-visualizer/',
  plugins: [react(), tailwindcss()],
  // PGlite loads its WebAssembly and extension files by URL relative to its own
  // modules; Vite's dependency pre-bundling would break those URLs.
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  // PGlite's worker code uses dynamic imports, which need ES module workers.
  worker: { format: 'es' },
  test: {
    include: ['src/**/*.test.ts'],
    // Starting Postgres takes a few seconds.
    testTimeout: 30_000,
  },
})
