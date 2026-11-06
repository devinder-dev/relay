// Checks queue isolation and nonblocking claims using independent connections and barriers.
import { afterAll, expect, test } from "bun:test";
import { claimDeliveries } from "../../src/repositories/queue.ts";
import { testDb } from "./helpers.ts";
import { workerFixture } from "./worker-fixture.ts";

const f = workerFixture(), blocker = testDb({ poolMax: 1 });
afterAll(() => blocker.end({ timeout: 5 }));
// Step 1: a second delivery sharing the locked endpoint remains claimable.
test("SKIP LOCKED returns other due rows before the held delivery lock is released", async () => {
  const seed = await f.seed(2);
  await blocker.begin(async (tx) => {
    await tx`SELECT id FROM deliveries WHERE id = ${seed.deliveries[0]!} FOR UPDATE`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const claiming = f.claim();
    try {
      const rows = await Promise.race([claiming, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Claim waited for the held lock")), 1000);
      })]);
      expect(rows.map((r) => r.id)).toEqual([seed.deliveries[1]!]);
    } finally { clearTimeout(timer); claiming.catch(() => {}); }
  });
  await f.db`UPDATE deliveries SET status = 'dead' WHERE owner_id = ${seed.ownerId}`;
});
test("OF d avoids locking a shared event or endpoint", async () => {
  const seed = await f.seed(3);
  await blocker.begin(async (tx) => {
    const first = await claimDeliveries(tx, { batch: 1, leaseSeconds: 60, maxTries: 3 });
    expect(first).toHaveLength(1);
    const rest = await f.claim(3, 5);
    expect(rest).toHaveLength(2);
    expect(rest.every((r) => r.id !== first[0]!.id)).toBe(true);
  });
  await f.db`UPDATE deliveries SET status = 'dead' WHERE owner_id = ${seed.ownerId}`;
});
// Step 2: invalid rows sorted before good work cannot starve the batch.
test("foreign event and foreign endpoint ownership are filtered before LIMIT", async () => {
  const a = await f.seed(), b = await f.seed(0);
  const [bEvent] = await f.db`INSERT INTO events (owner_id, type, payload) VALUES (${b.ownerId}, 'test', '{}') RETURNING id`;
  const planted: string[] = [];
  for (const [event, endpoint] of [[bEvent!.id, a.endpointId], [a.events[0]!, b.endpointId]]) {
    const [d] = await f.db`INSERT INTO deliveries (owner_id, event_id, endpoint_id, next_attempt_at)
      VALUES (${a.ownerId}, ${event}, ${endpoint}, now() - interval '1 day') RETURNING id`;
    planted.push(d!.id);
  }
  const rows = await f.claim(3, 1);
  expect(rows.map((r) => r.id)).toEqual(a.deliveries);
  for (const id of planted) { expect((await f.row(id)).attempts).toBe(0); }
  await f.db`UPDATE deliveries SET status = 'dead' WHERE owner_id = ${a.ownerId}`;
});
