import { expect, test } from './fixtures'

// The gate in front of everything else: a key that works gets you in, one that
// doesn't gets a message, and no key at all gets you sent back.
//
// The message is the API's own wording, from api/src/errors.ts. src/mocks.ts used to guess
// at it, and this test asserted the guess.

// Only this test sends a key the API refuses, so only this test expects the browser's own
// note about the 401. The other two keep the strict console guard.
test.describe('a refused key', () => {
  test.use({ expectedConsoleErrors: [/Failed to load resource.*401/] })

  test('shows the error from the contract', async ({ page }) => {
    await page.goto('/')
    await page.getByLabel('API key').fill('nope')
    await page.getByRole('button', { name: 'Connect' }).click()

    await expect(page.getByText('A valid API key is required')).toBeVisible()
    await expect(page).toHaveURL('/')
  })
})

test('a key that works lands on the delivery log', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('API key').fill('relay_live_8f2k')
  await page.getByRole('button', { name: 'Connect' }).click()

  await expect(page).toHaveURL('/deliveries')
  await expect(page.getByRole('heading', { name: 'Delivery log' })).toBeVisible()
})

test('without a key, a deep link goes back to Connect', async ({ page }) => {
  // Straight to an inside page, no key in sessionStorage. The guard in App.tsx
  // has to send us back, or the screens are reachable by typing a URL.
  await page.goto('/endpoints')

  await expect(page).toHaveURL('/')
  await expect(page.getByRole('heading', { name: 'Connect to Relay' })).toBeVisible()
})
