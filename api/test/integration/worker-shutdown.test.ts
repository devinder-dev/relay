// Exercises real process signals during startup, a claim, HTTP work and stalled finalization.
import { afterAll, expect, test } from "bun:test";
import { workerFixture } from "./worker-fixture.ts";
import { testDb } from "./helpers.ts";
import { within, workerChild } from "./worker-process-fixture.ts";

const f = workerFixture(), blocker = testDb({ poolMax: 1 }), observer = testDb({ poolMax: 1 });
afterAll(async () => { await blocker.end({ timeout: 5 }); await observer.end({ timeout: 5 }); });
async function waitForLock(pattern: string) {
  const deadline = performance.now() + 4000;
  while (true) {
    const [row] = await observer`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = 'relay-api'
        AND wait_event_type = 'Lock' AND query LIKE ${pattern}`;
    if (row!.count) return;
    if (performance.now() > deadline) throw new Error("Worker did not reach its lock");
    await Bun.sleep(10);
  }
}
// Step 1: SIGTERM during connection startup is handled before the health server exists.
test("SIGTERM during database startup exits zero promptly", async () => {
  const child = workerChild("", "postgres://relay:test@127.0.0.1:1/relay");
  try {
    // A failed startup connection log proves signal handlers are installed.
    const deadline = performance.now() + 3000;
    while (!child.output().includes("retrying")) {
      if (performance.now() > deadline) throw new Error("No startup progress log");
      await Bun.sleep(10);
    }
    child.child.kill("SIGTERM");
    expect(await within(child.exited, 2000)).toBe(0);
    expect(child.output()).not.toContain("worker ready");
  } finally { await child.close(); }
});
test("SIGTERM waits for an in-flight HTTP response and finalizes it", async () => {
  const seen = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    seen.resolve(); await release.promise; return new Response("ok");
  } });
  const origin = `http://127.0.0.1:${server.port}`, seed = await f.seed(1, origin + "/hooks");
  const child = workerChild(origin);
  try {
    await within(seen.promise); child.child.kill("SIGTERM"); release.resolve();
    expect(await within(child.exited)).toBe(0);
    expect((await f.row(seed.deliveries[0]!)).status).toBe("delivered");
    expect(child.output()).not.toContain(seed.secret);
  } finally { release.resolve(); await child.close(); server.stop(true); }
});
// Step 2: a claim already in progress is finished even if the signal arrived during its SQL.
test("SIGTERM during a blocked claim still processes the returned batch", async () => {
  let hits = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { hits++; return new Response("ok"); } });
  const origin = `http://127.0.0.1:${server.port}`, seed = await f.seed(1, origin + "/hooks");
  let child: ReturnType<typeof workerChild> | undefined;
  try {
    await blocker.begin(async (tx) => {
      await tx`LOCK TABLE events IN ACCESS EXCLUSIVE MODE`;
      child = workerChild(origin);
      await within(child.ready); await waitForLock("%WITH due AS%"); child.child.kill("SIGTERM");
    });
    expect(await within(child!.exited)).toBe(0);
    expect(hits).toBe(1); expect((await f.row(seed.deliveries[0]!)).status).toBe("delivered");
  } finally { await child?.close(); server.stop(true); }
});
test("a stalled finalize hits the twenty-second drain deadline and logs the open lease", async () => {
  const seen = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
    seen.resolve(); await release.promise; return new Response("ok");
  } });
  const origin = `http://127.0.0.1:${server.port}`, seed = await f.seed(1, origin + "/hooks");
  const child = workerChild(origin, undefined, true);
  try {
    await within(child.ready).catch((error) => { throw new Error(`${error.message}: ${child.output()}`); });
    await within(seen.promise);
    const leased = await f.row(seed.deliveries[0]!);
    await blocker.begin(async (tx) => {
      await tx`SELECT id FROM deliveries WHERE id = ${leased.id} FOR UPDATE`;
      release.resolve(); await waitForLock("%INSERT INTO attempts%");
      child.child.kill("SIGTERM");
      expect(await within(child.exited, 23_000)).toBe(1);
      expect(child.output()).toContain("drain deadline exceeded");
      expect(child.output()).toContain(leased.lease_id);
    });
    expect((await f.row(leased.id)).lease_id).toBe(leased.lease_id);
    await f.db`UPDATE deliveries SET status = 'dead' WHERE id = ${leased.id}`;
  } finally { release.resolve(); await child.close(); server.stop(true); }
}, 30_000);
