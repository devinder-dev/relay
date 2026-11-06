import { test as base, expect } from '@playwright/test'
import { installApiMock } from './api-mock'

// A test that also fails when the browser console logs an error.
//
// Why: counting rows can't catch two React children sharing a key — React still
// draws both rows and only warns. The warning is the only visible symptom, so a
// test that ignores the console can't see the bug at all. Proven by putting the
// duplicate id back: the row count stayed right and the test stayed green.
//
// This runs against the dev server, where React still emits these warnings; a
// production build strips them.
export const test = base.extend<{
  apiMock: void
  /**
   * Console errors a test means to cause, as patterns.
   *
   * Chrome logs "Failed to load resource" for every refused request, so a test that checks
   * what a rejected key looks like would otherwise fail on its own 401. Declaring it per test
   * keeps the guard strict everywhere else: a request we did not mean to make still fails.
   */
  expectedConsoleErrors: RegExp[]
  noConsoleErrors: void
}>({
  expectedConsoleErrors: [[], { option: true }],
  // The screens call the real API client; this answers it from the fixtures. Registered
  // before the test navigates, or the first request would escape to a server that is not there.
  apiMock: [
    async ({ page }, use) => {
      await installApiMock(page)
      await use()
    },
    { auto: true },
  ],

  noConsoleErrors: [
    async ({ page, expectedConsoleErrors }, use) => {
      const errors: string[] = []
      page.on('console', (m) => {
        if (m.type() !== 'error') return
        if (expectedConsoleErrors.some((pattern) => pattern.test(m.text()))) return
        errors.push(m.text())
      })
      // An uncaught exception is never expected, whatever a test declares.
      page.on('pageerror', (e) => errors.push(String(e)))

      await use()

      expect(errors, `browser console errors:\n${errors.join('\n')}`).toEqual([])
    },
    { auto: true }, // every test in a file that imports this one gets it
  ],
})

export { expect } from '@playwright/test'
