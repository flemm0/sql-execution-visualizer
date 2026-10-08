import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://localhost:4173/sql-execution-visualizer/'

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  // A fixed locale, so numbers render as "1,278" on every machine.
  use: { baseURL, locale: 'en-US' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Smoke tests run against the production build, as GitHub Pages serves it.
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
