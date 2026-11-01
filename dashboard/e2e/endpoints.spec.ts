import { expect, test } from './fixtures'
import { connect } from './connect-first'

// src/mocks.ts starts with three endpoints. Writing the number out means
// toHaveCount can wait for the table, where count() would read 0 before React
// had rendered and quietly compare against nothing.
const START = 3

test.beforeEach(async ({ page }) => {
  await connect(page)
  await page.getByRole('link', { name: 'Endpoints' }).click()
  await expect(page.getByRole('heading', { name: 'Endpoints' })).toBeVisible()
  await expect(page.locator('tbody tr')).toHaveCount(START)
})

test('two added endpoints are two separate rows', async ({ page }) => {
  // They used to share the mock's id. Counting rows does NOT catch that: React
  // still draws both rows and only warns. The noConsoleErrors fixture is what
  // fails the test — see e2e/fixtures.ts. Proven by putting the duplicate id back.
  const rows = page.locator('tbody tr')

  for (const [name, url] of [
    ['First one', 'https://example.com/hooks/one'],
    ['Second one', 'https://example.com/hooks/two'],
  ]) {
    await page.getByLabel('Name').fill(name)
    await page.getByLabel('URL').fill(url)
    await page.getByRole('button', { name: 'Add endpoint' }).click()
  }

  await expect(rows).toHaveCount(START + 2)
  await expect(page.getByRole('cell', { name: 'First one' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Second one' })).toBeVisible()
})

test('the signing secret is shown once and then let go', async ({ page }) => {
  await page.getByLabel('Name').fill('Ops webhook')
  await page.getByLabel('URL').fill('https://example.com/hooks/ops')
  await page.getByRole('button', { name: 'Add endpoint' }).click()

  const secret = page.getByText(/^whsec_/)
  await expect(secret).toBeVisible()

  await page.getByRole('button', { name: 'I have copied it' }).click()
  await expect(secret).toBeHidden()
})

// Customers' URLs must not point inside our own network (SSRF, docs/CONTEXT.md).
// The API rejects these with 422 invalid_endpoint_url; the form should too.
//
// Each case names the message it must produce. Asserting only "some error showed"
// let `loopback by name` pass with the loopback rule deleted: localhost fell
// through to the unrelated "does not look reachable" branch and still errored.
const PRIVATE = /private or internal/
const NOT_A_URL = /Enter a full URL/

const refused = [
  ['https://', 'not a whole URL', NOT_A_URL],
  ['example.com', 'no scheme', NOT_A_URL],
  ['http://example.com', 'plain http', /must start with https/],
  ['https://localhost:3000/hook', 'loopback by name', PRIVATE],
  ['https://127.0.0.1/hook', 'loopback by address', PRIVATE],
  ['https://0.0.0.0/hook', '0.0.0.0, which is loopback on Linux', PRIVATE],
  ['https://192.168.1.10/hook', 'a private range', PRIVATE],
  ['https://100.64.0.1/hook', 'the CGNAT range', PRIVATE],
  ['https://169.254.169.254/latest/meta-data', "the cloud's metadata address", PRIVATE],
  // Inside the cluster nothing is reached by number. These are the three the
  // comment in Endpoints.tsx names as the threat, and they used to get through.
  ['https://kubernetes.default.svc.cluster.local/hook', 'the Kubernetes API by name', PRIVATE],
  ['https://postgres.relay.svc.cluster.local:5432/hook', 'Postgres by name', PRIVATE],
  ['https://metadata.google.internal/token', 'cloud metadata by name', PRIVATE],
  // IPv6, which the host-name rule used to decide: these have no dots, so they fell
  // through to "does not look reachable" instead of being named as private.
  ['https://[::1]/hook', 'IPv6 loopback', PRIVATE],
  ['https://[fd00::1]/hook', 'an IPv6 unique-local address', PRIVATE],
  ['https://[fe80::1]/hook', 'an IPv6 link-local address', PRIVATE],
] as const

for (const [url, why, message] of refused) {
  test(`refuses ${why}: ${url}`, async ({ page }) => {
    await page.getByLabel('Name').fill('Should not be added')
    await page.getByLabel('URL').fill(url)
    await page.getByRole('button', { name: 'Add endpoint' }).click()

    // The right message, and nothing added. Either on its own would pass for the
    // wrong reason: a message can come from a different rule, and a row count can
    // stay put because the form silently did nothing.
    await expect(page.locator('form p')).toHaveText(message)
    await expect(page.locator('tbody tr')).toHaveCount(START)
  })
}

// The refusals must not be so eager that ordinary URLs stop working. The second
// one contains "localhost" inside a public name and has to be accepted.
for (const url of [
  'https://example.com/hooks/relay',
  'https://my-app.localhost.example.com/hook',
  'https://sub.domain.co.uk/x',
  // Public IP literals are legitimate endpoints. The IPv6 one is why the dot rule
  // had to stop applying to literals: [2001:db8::1] contains no dot at all.
  'https://93.184.216.34/hook',
  'https://[2001:db8::1]/hook',
]) {
  test(`accepts ${url}`, async ({ page }) => {
    await page.getByLabel('Name').fill('Good one')
    await page.getByLabel('URL').fill(url)
    await page.getByRole('button', { name: 'Add endpoint' }).click()

    await expect(page.locator('tbody tr')).toHaveCount(START + 1)
  })
}

// The contract's length limits: name 1–100, URL at most 2048 characters
// (docs/api.md, POST /v1/endpoints). Both sides of each boundary, in one test, so a
// rule that refuses everything cannot pass as a rule that refuses what it should.
test('an added endpoint is still there after leaving the screen', async ({ page }) => {
  // The rows used to live in this screen's own useState, so navigating away threw
  // the new endpoint away. Only in-app navigation counts here: page.goto() reloads
  // the page, which restarts the mock store and would hide the bug.
  await page.getByLabel('Name').fill('Survives navigation')
  await page.getByLabel('URL').fill('https://example.com/hooks/survives')
  await page.getByRole('button', { name: 'Add endpoint' }).click()
  await expect(page.locator('tbody tr')).toHaveCount(START + 1)

  await page.getByRole('link', { name: 'Delivery log' }).click()
  await expect(page.getByRole('heading', { name: 'Delivery log' })).toBeVisible()

  await page.getByRole('link', { name: 'Endpoints' }).click()
  await expect(page.locator('tbody tr')).toHaveCount(START + 1)
  await expect(page.getByRole('cell', { name: 'Survives navigation' })).toBeVisible()

  // The secret must not come back with it: it is shown once, and the stored row
  // never held it.
  await expect(page.getByText(/^whsec_/)).toBeHidden()
})

test('a name is accepted at 100 characters and refused at 101', async ({ page }) => {
  await page.getByLabel('URL').fill('https://example.com/hooks/limits')

  await page.getByLabel('Name').fill('n'.repeat(101))
  await page.getByRole('button', { name: 'Add endpoint' }).click()
  await expect(page.locator('form p')).toHaveText(/at most 100 characters/)
  await expect(page.locator('tbody tr')).toHaveCount(START)

  await page.getByLabel('Name').fill('n'.repeat(100))
  await page.getByRole('button', { name: 'Add endpoint' }).click()
  await expect(page.locator('tbody tr')).toHaveCount(START + 1)
})

test('a URL is accepted at 2048 characters and refused at 2049', async ({ page }) => {
  const base = 'https://example.com/'
  const ofLength = (total: number) => base + 'a'.repeat(total - base.length)

  await page.getByLabel('Name').fill('Long URL')

  const tooLong = ofLength(2049)
  expect(tooLong).toHaveLength(2049) // the test's own arithmetic, checked
  await page.getByLabel('URL').fill(tooLong)
  await page.getByRole('button', { name: 'Add endpoint' }).click()
  await expect(page.locator('form p')).toHaveText(/at most 2048 characters/)
  await expect(page.locator('tbody tr')).toHaveCount(START)

  const justFits = ofLength(2048)
  expect(justFits).toHaveLength(2048)
  await page.getByLabel('URL').fill(justFits)
  await page.getByRole('button', { name: 'Add endpoint' }).click()
  await expect(page.locator('tbody tr')).toHaveCount(START + 1)
})
