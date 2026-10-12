import { defineConfig, devices } from '@playwright/test'

const LOCAL_URL = 'http://localhost:4173/sql-execution-visualizer/'
// Set to the deployed site's URL to test it instead of a local build (the Live check workflow does).
const liveURL = process.env.LIVE_URL
const baseURL = liveURL ?? LOCAL_URL

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  // A fixed locale, so numbers render as "1,278" on every machine.
  use: { baseURL, locale: 'en-US' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Smoke tests run against the production build, as GitHub Pages serves it.
  // Against the live site, there's nothing to start.
  webServer: liveURL
    ? undefined
    : {
        command: 'npm run build && npm run preview -- --port 4173 --strictPort',
        url: LOCAL_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
})
