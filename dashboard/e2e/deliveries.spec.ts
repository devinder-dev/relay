import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { connect } from './connect-first'

// The fixtures in src/mocks.ts are fixed, so the counts are too. Writing them
// out means a test fails if a fixture quietly disappears, which is how two log
// rows ended up with no detail screen in the first place.
const ROWS = { all: 5, pending: 1, delivered: 2, dead: 2 }

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

// Opens one named delivery. `dead` holds two rows now, and "Old CRM" sorts first
// because the log is newest first, so a test that means a particular delivery has
// to say which one instead of taking whichever is on top.
async function openRow(page: Page, rowText: string) {
  await page.goto('/deliveries')
  await page.locator('tbody tr', { hasText: rowText }).locator('a').click()
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
  // An array, not a single string: the filter holds two rows now, and asserting
  // every one of them is what makes this a filter test rather than a count test.
  await expect(page.getByTestId('status')).toHaveText(Array(ROWS.dead).fill('dead'))

  await page.getByRole('button', { name: 'all', exact: true }).click()
  await expect(page.locator('tbody tr')).toHaveCount(ROWS.all)
})

test('replaying a dead delivery survives the 2 s reload', async ({ page }) => {
  // The detail screen reloads itself every 2 s while a delivery is pending.
  // Replay makes it pending, so the reload used to hand back the dead fixture
  // and undo the replay about two seconds later.
  // By name, not by position: the dead filter also holds the deleted-endpoint
  // delivery, which has no Replay button at all.
  await openRow(page, 'payment.failed')
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

test('the deleted-endpoint delivery opens and explains why Replay is gone', async ({ page }) => {
  // This row arrived with #7 and had no detail fixture registered, so it opened
  // "Delivery not found" while its fixture sat exported and unused. Counting rows
  // could not see it: the count was right, the row was there, only the screen
  // behind it was wrong.
  await openRow(page, 'Old CRM')

  await expect(page.getByText('Delivery not found')).toBeHidden()
  await expect(page.getByTestId('status')).toHaveText('dead')
  await expect(page.getByText('Old CRM')).toBeVisible()

  // The contract refuses this replay with 409 endpoint_deleted, so the button
  // must not be offered at all.
  await expect(page.getByRole('button', { name: 'Replay' })).toBeHidden()
  await expect(page.getByText(/endpoint was deleted/i)).toBeVisible()
})

test('a replay is still there in the log and on the way back', async ({ page }) => {
  // Before the shared store, replay only touched the detail screen's own Map: the
  // log kept saying dead/8 while the detail said pending/0, and the two disagreed
  // for the rest of the session. One source now, so this walks all three steps:
  // detail → log → detail.
  await openRow(page, 'payment.failed')
  await expect(page.getByTestId('status')).toHaveText('dead')

  await page.getByRole('button', { name: 'Replay' }).click()
  await expect(page.getByTestId('status')).toHaveText('pending')

  // The log: the row must have followed, both its status and its attempt count.
  await page.getByRole('link', { name: '← Back to the log' }).click()
  const row = page.locator('tbody tr', { hasText: 'payment.failed' })
  await expect(row.getByTestId('status')).toHaveText('pending')
  await expect(row).toContainText('0')

  // And back in again, to be sure it was stored and not just rendered once. Waiting
  // for the back link first, like openFirst does: the address changes before the DOM
  // does, so asserting on the status straight after the click reads the log's five.
  await row.getByRole('link').click()
  await expect(page.getByRole('link', { name: '← Back to the log' })).toBeVisible()
  await expect(page.getByTestId('status')).toHaveText('pending')
})

// This one asks for an id the API refuses, so the browser's own note about the 404 is
// expected. React's StrictMode runs the effect twice in development, so there are two.
test.describe('a missing delivery', () => {
  test.use({ expectedConsoleErrors: [/Failed to load resource.*404/] })

  test('an id that does not exist says so', async ({ page }) => {
    // The positive control for the test above: "Delivery not found" has to still
    // appear for a real miss, or that assertion proves nothing.
    await page.goto('/deliveries/0199ffff-ffff-7fff-bfff-ffffffffffff')

    await expect(page.getByText('Delivery not found')).toBeVisible()
    await expect(page.getByTestId('status')).toBeHidden()
  })
})
