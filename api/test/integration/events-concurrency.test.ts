// Holds event inserts at a real lock to prove concurrent retry keys save one event.
import { afterAll, expect, test } from "bun:test";
import { eventsFixture } from "./events-fixture.ts";
import { testDb } from "./helpers.ts";

// Step 1: requests, the lock holder and the observer cannot exhaust each other's pools.
const f = eventsFixture(10);
const blocker = testDb({ poolMax: 1 }), observer = testDb({ poolMax: 1 });
afterAll(async () => { await blocker.end({ timeout: 5 }); await observer.end({ timeout: 5 }); });
test("five locked requests with one key have one creator and four replays", async () => {
  const a = await f.owner();
  await f.endpoint(a.owner.id);
  const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const holding = blocker.begin(async (tx) => {
    await tx`LOCK TABLE events IN SHARE MODE`;
    ready.resolve();
    await release.promise;
  });
  holding.catch((error) => ready.reject(error));
  await ready.promise;
  const responses = Promise.all(Array.from({ length: 5 }, () => f.post(a.key, undefined, "race")));
  try {
    // Step 2: observe all five INSERTs waiting, rather than guessing with a fixed sleep.
    const deadline = performance.now() + 5_000;
    while (true) {
      const [row] = await observer`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = 'relay-api'
          AND wait_event_type = 'Lock' AND query LIKE '%INSERT INTO events%'
          AND query LIKE '%ON CONFLICT%'`;
      if (row!.count >= 5) break;
      if (performance.now() >= deadline) throw new Error("Five event inserts did not reach their locks");
      await Bun.sleep(10);
    }
  } finally {
    release.resolve();
    await holding;
    await responses;
  }
  const answers = await responses;
  expect(answers.map((r) => r.statusCode)).toEqual([202, 202, 202, 202, 202]);
  for (const res of answers) expect(res.json()).toEqual(answers[0]!.json());
  expect(answers.filter((r) => r.headers["idempotent-replayed"] === undefined)).toHaveLength(1);
  expect(answers.filter((r) => r.headers["idempotent-replayed"] === "true")).toHaveLength(4);
  const [events] = await f.sql`SELECT count(*)::int AS count FROM events WHERE owner_id = ${a.owner.id}`;
  const [deliveries] = await f.sql`SELECT count(*)::int AS count FROM deliveries WHERE owner_id = ${a.owner.id}`;
  expect(events!.count).toBe(1);
  expect(deliveries!.count).toBe(1);
}, 15_000);
