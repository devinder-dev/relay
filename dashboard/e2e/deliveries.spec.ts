import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { connect } from './connect-first'

// The fixtures in src/mocks.ts are fixed, so the counts are too. Writing them
// out means a test fails if a fixture quietly disappears, which is how two log
// rows ended up with no detail screen in the first place.
const ROWS = { all: 4, pending: 1, delivered: 2, dead: 1 }

test.beforeEach(async ({ page }) => {
  await connect(page)
})

// Opens the first row under a filter. Waiting for the heading, not just the URL:
// React Router changes the address before it renders, so the URL alone can be the
// detail screen while the DOM is still the log.
async function openFirst(page: Page, filter: keyof typeof ROWS) {
  await page.getByRole('button', { name: filter, exact: true }).click()
  await expect(page.locator('tbody tr')).toHaveCount(ROWS[filter])
  await page.locator('tbody a').first().click()
  await expect(page.getByRole('link', { name: '← Back to the log' })).toBeVisible()
}

test('every row in the log opens its delivery', async ({ page }) => {
  // Two of the four rows used to open "Delivery not found", because only the
  // pending and dead deliveries had a detail fixture.
  await expect(page.locator('tbody tr')).toHaveCount(ROWS.all)

  for (let i = 0; i < ROWS.all; i++) {
    await page.goto('/deliveries')
    await page.locator('tbody a').nth(i).click()

    await expect(page.getByRole('link', { name: '← Back to the log' })).toBeVisible()
    await expect(page.getByText('Delivery not found')).toBeHidden()
    await expect(page.getByTestId('status')).toBeVisible()
  }
})

test('the filters narrow the log and can be cleared', async ({ page }) => {
  await expect(page.locator('tbody tr')).toHaveCount(ROWS.all)

  await page.getByRole('button', { name: 'dead', exact: true }).click()
  await expect(page.locator('tbody tr')).toHaveCount(ROWS.dead)
  await expect(page.getByTestId('status')).toHaveText('dead')

  await page.getByRole('button', { name: 'all', exact: true }).click()
  await expect(page.locator('tbody tr')).toHaveCount(ROWS.all)
})

test('replaying a dead delivery survives the 2 s reload', async ({ page }) => {
  // The detail screen reloads itself every 2 s while a delivery is pending.
  // Replay makes it pending, so the reload used to hand back the dead fixture
  // and undo the replay about two seconds later.
  await openFirst(page, 'dead')
  await expect(page.getByTestId('status')).toHaveText('dead')

  await page.getByRole('button', { name: 'Replay' }).click()
  await expect(page.getByTestId('status')).toHaveText('pending')

  // Past two reloads, not one: the bug needed a single tick to show up.
  await page.waitForTimeout(5000)
  await expect(page.getByTestId('status')).toHaveText('pending')
})

test('a delivered delivery offers no Replay', async ({ page }) => {
  await openFirst(page, 'delivered')

  await expect(page.getByTestId('status')).toHaveText('delivered')
  await expect(page.getByRole('button', { name: 'Replay' })).toBeHidden()
})
