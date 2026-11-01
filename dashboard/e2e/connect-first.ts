import type { Page } from '@playwright/test'

// Every screen except Connect needs a key in sessionStorage. Going through the
// real form rather than writing the key directly means the tests break if the
// gate breaks, instead of quietly walking around it.
export async function connect(page: Page) {
  await page.goto('/')
  await page.getByLabel('API key').fill('relay_live_8f2k')
  await page.getByRole('button', { name: 'Connect' }).click()
  await page.waitForURL('/deliveries')
}
