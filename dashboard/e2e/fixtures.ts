import { test as base, expect } from '@playwright/test'

// A test that also fails when the browser console logs an error.
//
// Why: counting rows can't catch two React children sharing a key — React still
// draws both rows and only warns. The warning is the only visible symptom, so a
// test that ignores the console can't see the bug at all. Proven by putting the
// duplicate id back: the row count stayed right and the test stayed green.
//
// This runs against the dev server, where React still emits these warnings; a
// production build strips them.
export const test = base.extend<{ noConsoleErrors: void }>({
  noConsoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = []
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
      page.on('pageerror', (e) => errors.push(String(e)))

      await use()

      expect(errors, `browser console errors:\n${errors.join('\n')}`).toEqual([])
    },
    { auto: true }, // every test in a file that imports this one gets it
  ],
})

export { expect } from '@playwright/test'
