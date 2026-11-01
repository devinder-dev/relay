import { expect, test } from './fixtures'

// The gate in front of everything else: a key that works gets you in, one that
// doesn't gets a message, and no key at all gets you sent back.

test('a key the API would reject shows the error from the contract', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('API key').fill('nope')
  await page.getByRole('button', { name: 'Connect' }).click()

  await expect(page.getByText('Unknown or revoked API key')).toBeVisible()
  await expect(page).toHaveURL('/')
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
