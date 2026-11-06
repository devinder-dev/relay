// Holds real delivery locks so replay races are checked at a known database barrier.
import { afterAll, expect, test } from "bun:test";
import { replayFixture } from "./deliveries-replay-fixture.ts";
import { testDb } from "./helpers.ts";

const f = replayFixture();
const blocker = testDb({ poolMax: 1 }), observer = testDb({ poolMax: 1 });
afterAll(async () => { await blocker.end({ timeout: 5 }); await observer.end({ timeout: 5 }); });
async function waitForReplays(count: number) {
  const deadline = performance.now() + 5000;
  while (true) {
    const [row] = await observer`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = 'relay-api'
        AND wait_event_type = 'Lock' AND query LIKE '%AS endpoint_deleted%' AND query LIKE '%FOR UPDATE OF d%'`;
    if (row!.count >= count) return;
    if (performance.now() >= deadline) throw new Error(`${count} replays did not reach their row locks`);
    await Bun.sleep(10);
  }
}
// Step 1: a blocked replay must decide using the updated row after the holder commits.
test("a delivery changed to delivered while replay waits gives already_delivered", async () => {
  const a = await f.seed();
  let response: ReturnType<typeof f.replay> | undefined;
  try {
    await blocker.begin(async (tx) => {
      await tx`SELECT id FROM deliveries WHERE owner_id = ${a.owner.id} AND id = ${a.id} FOR UPDATE`;
      response = f.replay(a.key, a.id);
      // inject is thenable; observing it starts the request before the observer polls.
      response.then(() => {}, () => {});
      await waitForReplays(1);
      await tx`UPDATE deliveries SET status = 'delivered', delivered_at = now()
        WHERE owner_id = ${a.owner.id} AND id = ${a.id}`;
    });
    const res = await response!;
    expect(res.statusCode).toBe(409); expect(res.json().error.code).toBe("already_delivered");
    const row = await f.row(a.owner.id, a.id);
    expect(row.status).toBe("delivered"); expect(row.attempts).toBe(8);
  } finally { await response; }
}, 10_000);
// Step 2: after one reset the second replay sees pending and waiting, which is also allowed.
test("two simultaneous replays both succeed and leave one reset pending row", async () => {
  const a = await f.seed();
  let responses: Promise<Awaited<ReturnType<typeof f.replay>>[]> | undefined;
  try {
    await blocker.begin(async (tx) => {
      await tx`SELECT id FROM deliveries WHERE owner_id = ${a.owner.id} AND id = ${a.id} FOR UPDATE`;
      responses = Promise.all([f.replay(a.key, a.id), f.replay(a.key, a.id)]);
      await waitForReplays(2);
    });
    const results = await responses!;
    expect(results.map((res) => res.statusCode)).toEqual([202, 202]);
    for (const res of results) { expect(res.json().status).toBe("pending"); expect(res.json().attempts).toBe(0); }
    const row = await f.row(a.owner.id, a.id);
    expect(row.status).toBe("pending"); expect(row.attempts).toBe(0); expect(row.lease_id).toBeNull();
  } finally { await responses; }
}, 10_000);
