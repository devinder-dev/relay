// Exercises real local sends and queue loops through retry, failure, deletion and concurrency.
import { afterAll, expect, test } from "bun:test";
import { createReceiver } from "../../src/demo/receiver.ts";
import { createStop, runLoop } from "../../src/worker/loop.ts";
import { processDelivery } from "../../src/worker/process.ts";
import { sendWebhook } from "../../src/worker/send.ts";
import { workerFixture } from "./worker-fixture.ts";

const f = workerFixture();
const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(() => { for (const server of servers) server.stop(true); });
// Step 1: waits are made due by SQL in this test; production retry arithmetic is checked separately.
test("two signed failures followed by success give three history rows and delivered", async () => {
  const seed = await f.seed();
  const receiver = createReceiver({ secret: seed.secret, port: 0 }); servers.push(receiver);
  const origin = `http://receiver.test:${receiver.port}`;
  await f.db`UPDATE endpoints SET url = ${origin + "/hooks"} WHERE id = ${seed.endpointId}`;
  await f.db`UPDATE events SET payload = ${f.db.json({ demo: { fail: 2 } })} WHERE id = ${seed.events[0]!}`;
  const send = (input: Parameters<typeof sendWebhook>[0]) => sendWebhook(input, {
    lookup: async () => ["127.0.0.1"], allowOrigins: [origin], deadlineMs: 1000,
  });
  for (let i = 1; i <= 3; i++) {
    const row = (await f.claim())[0]!;
    await processDelivery(row, { db: f.db, config: f.config, send, log: () => {} });
    const after = await f.row(row.id);
    expect(after.status).toBe(i === 3 ? "delivered" : "pending");
    if (i < 3) {
      expect(after.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 500);
      await f.expire(row.id);
    }
  }
  const attempts = await f.db`SELECT status_code FROM attempts WHERE delivery_id = ${seed.deliveries[0]!} ORDER BY id`;
  expect(attempts.map((r) => r.status_code)).toEqual([500, 500, 200]);
});
test("an always-failing receiver becomes dead at the budget; deleted endpoints send nothing", async () => {
  await f.seed();
  let hits = 0;
  const send = async () => { hits++; return { startedAt: new Date(), durationMs: 1, statusCode: 500, error: null, excerpt: "failed" }; };
  let id = "";
  for (let i = 0; i < 3; i++) {
    const row = (await f.claim())[0]!; id = row.id;
    await processDelivery(row, { db: f.db, config: f.config, send, log: () => {} });
    if (i < 2) await f.expire(id);
  }
  expect(hits).toBe(3); expect((await f.row(id)).status).toBe("dead");
  const deleted = await f.seed();
  await f.db`UPDATE endpoints SET deleted_at = now() WHERE id = ${deleted.endpointId}`;
  const row = (await f.claim())[0]!;
  await processDelivery(row, { db: f.db, config: f.config, send, log: () => {} });
  expect(hits).toBe(3); expect((await f.row(row.id)).last_error).toBe("endpoint_deleted");
  expect((await f.db`SELECT * FROM attempts WHERE delivery_id = ${row.id}`)).toHaveLength(0);
});
// Step 2: three loops share fifty due rows and valid leases without duplicate sends.
test("three loops deliver fifty events exactly once within valid leases", async () => {
  const counts = new Map<string, number>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const id = request.headers.get("webhook-id")!; counts.set(id, (counts.get(id) ?? 0) + 1);
    return new Response("ok");
  } }); servers.push(server);
  const origin = `http://receiver.test:${server.port}`;
  const seed = await f.seed(50, origin + "/hooks");
  const stops = Array.from({ length: 3 }, () => createStop());
  const loops = stops.map((stop) => runLoop({ db: f.db, config: f.config, stop, heartbeat: { last: performance.now() },
    activeLeases: new Map(), leaseSeconds: 300, log: () => {},
    send: (input) => sendWebhook(input, { allowOrigins: [origin], lookup: async () => ["127.0.0.1"] }),
  }));
  try {
    const deadline = performance.now() + 10_000;
    while (true) {
      const [row] = await f.db`SELECT count(*)::int AS count FROM deliveries
        WHERE owner_id = ${seed.ownerId} AND status = 'delivered'`;
      if (row!.count === 50) break;
      if (performance.now() >= deadline) throw new Error("Fifty deliveries did not finish");
      await Bun.sleep(10);
    }
  } finally { stops.forEach((stop) => stop.stop()); await Promise.all(loops); }
  expect(counts.size).toBe(50);
  expect([...counts.values()].every((count) => count === 1)).toBe(true);
}, 15_000);
// Step 3: an unfinished try is bounded even when processing repeatedly rejects before finalize.
test("loop exhausts repeated unfinished tries and logs every rejected result", async () => {
  const seed = await f.seed(), stop = createStop(), messages: string[] = [];
  let sends = 0, idle = 0;
  await runLoop({ db: f.db, config: f.config, stop, heartbeat: { last: 0 }, activeLeases: new Map(),
    send: async () => { sends++; throw new Error("unfinished try"); }, log: (_level, message) => messages.push(message),
    sleep: async () => {
      const row = await f.row(seed.deliveries[0]!);
      if (row.status === "dead" || ++idle >= 8) stop.stop();
      else await f.expire(row.id);
    },
  });
  expect(sends).toBe(3);
  expect((await f.row(seed.deliveries[0]!)).status).toBe("dead");
  expect(messages.filter((message) => message.includes("failed to finish"))).toHaveLength(3);
});
