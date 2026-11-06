// Proves lease fencing, atomic history writes and finite recovery from repeated crashes.
import { expect, test } from "bun:test";
import { exhaustDeliveries, finalizeAttempt, finalizeDeleted } from "../../src/repositories/queue.ts";
import { workerFixture, attempt } from "./worker-fixture.ts";

const f = workerFixture();
// Step 1: claim counts the try and leases the row without creating an HTTP history entry.
test("claim, expiry, reclaim and stale finalize preserve the new lease and record history", async () => {
  const seed = await f.seed();
  const first = (await f.claim())[0]!;
  expect(first.id).toBe(seed.deliveries[0]!);
  expect(first.attempts).toBe(1);
  expect((await f.claim())).toHaveLength(0);
  await f.expire(first.id);
  const second = (await f.claim())[0]!;
  expect(second.lease_id).not.toBe(first.lease_id);
  expect(second.attempts).toBe(2);
  const before = await f.row(first.id);
  expect(await finalizeAttempt(f.db, { deliveryId: first.id, leaseId: first.lease_id, attempt,
    state: { status: "delivered", next: new Date() } })).toBe("lease_lost");
  expect(await f.row(first.id)).toEqual(before);
  expect((await f.db`SELECT * FROM attempts WHERE delivery_id = ${first.id}`)).toHaveLength(1);
  expect(await finalizeAttempt(f.db, { deliveryId: second.id, leaseId: second.lease_id, attempt,
    state: { status: "delivered", next: new Date() } })).toBe("ok");
  expect((await f.row(first.id)).status).toBe("delivered");
});
test("an expired last try becomes dead without ever finalizing", async () => {
  const seed = await f.seed();
  for (let count = 1; count <= 3; count++) {
    await exhaustDeliveries(f.db, 3);
    const rows = await f.claim();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempts).toBe(count);
    await f.expire(rows[0]!.id);
  }
  expect(await exhaustDeliveries(f.db, 3)).toBe(1);
  expect(await f.claim()).toHaveLength(0);
  const row = await f.row(seed.deliveries[0]!);
  expect(row.status).toBe("dead"); expect(row.attempts).toBe(3); expect(row.lease_id).toBeNull();
  expect(row.last_error).toBeNull(); expect(row.last_status_code).toBeNull();
});
// Step 2: a failed history INSERT must not release or change the delivery.
test("failed attempt INSERT rolls back; successful finalize sets all public outcome fields", async () => {
  await f.seed(); const row = (await f.claim())[0]!;
  const before = await f.row(row.id);
  await expect(finalizeAttempt(f.db, { deliveryId: row.id, leaseId: row.lease_id,
    attempt: { ...attempt, durationMs: 2 ** 40 }, state: { status: "delivered", next: new Date() } })).rejects.toThrow();
  expect(await f.row(row.id)).toEqual(before);
  expect((await f.db`SELECT * FROM attempts WHERE delivery_id = ${row.id}`)).toHaveLength(0);
  await finalizeAttempt(f.db, { deliveryId: row.id, leaseId: row.lease_id, attempt,
    state: { status: "delivered", next: new Date() } });
  const done = await f.row(row.id);
  expect(done.lease_id).toBeNull(); expect(done.last_status_code).toBe(200);
  expect(done.delivered_at).toBeInstanceOf(Date);
});
test("deleted finalization is fenced and writes no attempt", async () => {
  await f.seed(); const row = (await f.claim())[0]!;
  expect(await finalizeDeleted(f.db, { deliveryId: row.id, leaseId: crypto.randomUUID() })).toBe("lease_lost");
  expect(await finalizeDeleted(f.db, { deliveryId: row.id, leaseId: row.lease_id })).toBe("ok");
  const done = await f.row(row.id);
  expect(done.status).toBe("dead"); expect(done.last_error).toBe("endpoint_deleted");
  expect(done.last_status_code).toBeNull(); expect(done.lease_id).toBeNull();
  expect((await f.db`SELECT * FROM attempts WHERE delivery_id = ${row.id}`)).toHaveLength(0);
});
test("replay-cleared lease rejects an old finalizer but retains its history", async () => {
  await f.seed(); const row = (await f.claim())[0]!;
  await f.db`UPDATE deliveries SET attempts = 0, lease_id = NULL, next_attempt_at = now() WHERE id = ${row.id}`;
  const before = await f.row(row.id);
  expect(await finalizeAttempt(f.db, { deliveryId: row.id, leaseId: row.lease_id, attempt,
    state: { status: "delivered", next: new Date() } })).toBe("lease_lost");
  expect(await f.row(row.id)).toEqual(before);
  expect((await f.db`SELECT * FROM attempts WHERE delivery_id = ${row.id}`)).toHaveLength(1);
  await f.db`UPDATE deliveries SET status = 'dead' WHERE id = ${row.id}`;
});
