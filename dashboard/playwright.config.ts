import { defineConfig, devices } from '@playwright/test'

// End-to-end tests: a real browser clicking the real app.
//
// The app still runs on the fixtures in src/mocks.ts, so every run sees the same
// data and the tests can assert exact values. When src/api.ts replaces the mocks
// in 5.3, these same tests become the proof that the swap changed nothing.

export default defineConfig({
  testDir: './e2e',

  // CI must never pass because someone left a .only in a file.
  forbidOnly: !!process.env.CI,

  // Locally a flaky test should be visible, not retried away. In CI one retry
  // separates "broken" from "unlucky" without hiding a real failure.
  retries: process.env.CI ? 1 : 0,

  // One worker in CI: the runner has 2 cores and a Vite dev server to feed.
  workers: process.env.CI ? 1 : undefined,

  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: 'http://localhost:5173',
    // Kept only for a failing test: enough to see what happened, nothing to wade
    // through when everything is green.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  // Playwright starts Vite itself, so there is no "did you remember to run npm run
  // dev" step. Locally it reuses a server that is already up; in CI it always
  // starts its own.
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60 * 1000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
