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
]) {
  test(`accepts ${url}`, async ({ page }) => {
    await page.getByLabel('Name').fill('Good one')
    await page.getByLabel('URL').fill(url)
    await page.getByRole('button', { name: 'Add endpoint' }).click()

    await expect(page.locator('tbody tr')).toHaveCount(START + 1)
  })
}
