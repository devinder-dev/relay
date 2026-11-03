// Checks endpoint limits with controlled database locks, without timing guesses.
import { afterAll, expect, test } from "bun:test";
import { lockOwner } from "../../src/repositories/endpoints.ts";
import { endpointFixture } from "./endpoints-fixture.ts";
import { testDb } from "./helpers.ts";

const f = endpointFixture();
const blocker = testDb({ poolMax: 1 });
afterAll(() => blocker.end({ timeout: 5 }));
async function seed(key: string, count: number) {
  for (let i = 0; i < count; i++) expect((await f.post(key, { name: `Webhook ${i}` })).statusCode).toBe(201);
}
// Step 1: only live endpoints consume an owner's quota.
test("20 creates succeed, the 21st is refused, and soft deletion frees a slot", async () => {
  const a = await f.owner();
  await seed(a.key, 20);
  const refused = await f.post(a.key);
  expect(refused.statusCode).toBe(409);
  expect(refused.json().error.code).toBe("endpoint_limit_reached");
  await f.sql`UPDATE endpoints SET deleted_at = now()
    WHERE owner_id = ${a.owner.id} AND id = (
      SELECT id FROM endpoints WHERE owner_id = ${a.owner.id} AND deleted_at IS NULL ORDER BY id LIMIT 1)`;
  expect((await f.post(a.key)).statusCode).toBe(201);
}, 15_000);

// Step 2: freeze inserts so both contenders reach the lock before the blocker commits.
test("two simultaneous creates at 19 produce one 201, one 409 and 20 live endpoints", async () => {
  const a = await f.owner();
  await seed(a.key, 19);
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holding = blocker.begin(async (tx) => {
    await tx`LOCK TABLE endpoints IN SHARE MODE`;
    ready.resolve();
    await release.promise;
  });
  // Handle a setup failure immediately, so it cannot become an unhandled rejection.
  holding.catch((error) => ready.reject(error));
  await ready.promise;
  const responses = Promise.all([f.post(a.key), f.post(a.key)]);
  try {
    const deadline = performance.now() + 5_000;
    while (true) {
      const [row] = await f.sql`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = 'relay-api' AND wait_event_type = 'Lock'`;
      if (row && row.count >= 2) break;
      if (performance.now() >= deadline) throw new Error("Two creates did not reach their database locks");
      await Bun.sleep(10);
    }
  } finally {
    release.resolve();
    await holding;
    await responses;
  }
  expect((await responses).map((res) => res.statusCode).sort()).toEqual([201, 409]);
  const [row] = await f.sql`SELECT count(*)::int AS count FROM endpoints
    WHERE owner_id = ${a.owner.id} AND deleted_at IS NULL`;
  expect(row?.count).toBe(20);
}, 15_000);

// Step 3: a different owner's create must not wait for the owner whose row is locked.
test("locking owner A still lets owner B create before the transaction ends", async () => {
  const a = await f.owner(), b = await f.owner();
  await blocker.begin(async (tx) => {
    await tx`SELECT 1 FROM owners WHERE id = ${a.owner.id} FOR UPDATE`;
    expect((await f.post(b.key)).statusCode).toBe(201);
  });
}, 10_000);

// Step 4: the owner lock queues endpoint creates only; that owner's events never wait for it.
test("the owner lock of an endpoint create doesn't block the owner's event inserts", async () => {
  const a = await f.owner();
  await blocker.begin(async (tx) => {
    await lockOwner(tx, a.owner.id);
    await f.sql.begin(async (other) => {
      await other`SET LOCAL lock_timeout = '1s'`;
      await other`INSERT INTO events (owner_id, type, payload) VALUES (${a.owner.id}, 'test.lock', '{}'::jsonb)`;
    });
  });
}, 10_000);
