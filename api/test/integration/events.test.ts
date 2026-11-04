// Checks atomic event creation, endpoint matching and retry-key behavior through HTTP.
import { expect, test } from "bun:test";
import { createEvent } from "../../src/services/events.ts";
import { eventsFixture } from "./events-fixture.ts";

const f = eventsFixture();
// Step 1: only this owner's live matching endpoints receive pending deliveries.
test("202 saves nested JSON and exactly the two live matching deliveries", async () => {
  const a = await f.owner(), b = await f.owner();
  const wildcard = await f.endpoint(a.owner.id), exact = await f.endpoint(a.owner.id, ["invoice.paid"]);
  await f.endpoint(a.owner.id, ["order.created"]);
  await f.endpoint(a.owner.id, ["*"], true);
  await f.endpoint(b.owner.id);
  const payload = { nested: { items: [1, { paid: true }], emoji: "😀" } };
  const res = await f.post(a.key, { type: "invoice.paid", payload });
  expect(res.statusCode).toBe(202);
  const body = res.json();
  expect(Object.keys(body).sort()).toEqual(["created_at", "deliveries", "id", "type"]);
  expect(typeof body.deliveries).toBe("number");
  expect(body.deliveries).toBe(2);
  expect(new Date(body.created_at).toISOString()).toBe(body.created_at);
  const events = await f.sql`SELECT id, payload FROM events WHERE owner_id = ${a.owner.id}`;
  expect(events).toHaveLength(1);
  expect(events[0]!.payload).toEqual(payload);
  const rows = await f.sql`SELECT endpoint_id, status, attempts FROM deliveries WHERE owner_id = ${a.owner.id}`;
  expect(rows.map((r) => r.endpoint_id).sort()).toEqual([wildcard, exact].sort());
  for (const row of rows) { expect(row.status).toBe("pending"); expect(row.attempts).toBe(0); }
});
test("no matching endpoint still saves the event with zero deliveries", async () => {
  const a = await f.owner();
  await f.endpoint(a.owner.id, ["order.created"]);
  expect((await f.post(a.key)).json().deliveries).toBe(0);
  const [row] = await f.sql`SELECT count(*)::int AS count FROM events WHERE owner_id = ${a.owner.id}`;
  expect(row!.count).toBe(1);
});

// Step 2: keys are owner-scoped; omitting a key always creates a new event.
test("a repeated key returns the same answer and only the second has a replay header", async () => {
  const a = await f.owner(), b = await f.owner();
  const first = await f.post(a.key, undefined, "same");
  const second = await f.post(a.key, undefined, "same");
  expect(first.statusCode).toBe(202);
  expect(second.statusCode).toBe(202);
  expect(second.json()).toEqual(first.json());
  expect(first.headers["idempotent-replayed"]).toBeUndefined();
  expect(second.headers["idempotent-replayed"]).toBe("true");
  const other = await f.post(b.key, undefined, "same");
  expect(other.json().id).not.toBe(first.json().id);
  const [row] = await f.sql`SELECT count(*)::int AS count FROM events WHERE owner_id = ${a.owner.id}`;
  expect(row!.count).toBe(1);
  const noKey1 = await f.post(a.key), noKey2 = await f.post(a.key);
  expect(noKey1.json().id).not.toBe(noKey2.json().id);
});
test("a lost answer and a changed body keep the original count without new fan-out", async () => {
  const a = await f.owner();
  await f.endpoint(a.owner.id);
  const first = await f.post(a.key, undefined, "lost");
  const lateEndpoint = await f.endpoint(a.owner.id);
  const retry = await f.post(a.key, undefined, "lost");
  const changed = await f.post(a.key, { type: "order.created", payload: { changed: true } }, "lost");
  expect(first.json().deliveries).toBe(1);
  expect(retry.json()).toEqual(first.json());
  expect(changed.json()).toEqual(first.json());
  expect(changed.headers["idempotent-replayed"]).toBe("true");
  const [events] = await f.sql`SELECT count(*)::int AS count FROM events WHERE owner_id = ${a.owner.id}`;
  const [late] = await f.sql`SELECT count(*)::int AS count FROM deliveries
    WHERE owner_id = ${a.owner.id} AND endpoint_id = ${lateEndpoint}`;
  expect(events!.count).toBe(1);
  expect(late!.count).toBe(0);
});

// Step 3: even an error after inserting deliveries rolls all writes back.
test("failed fan-out propagates its error and saves neither event nor deliveries", async () => {
  const a = await f.owner();
  const endpoint = await f.endpoint(a.owner.id);
  const failure = new Error("fan-out failed");
  await expect(createEvent(f.sql, a.owner.id, { type: "invoice.paid", payload: {} }, "rollback", {
    fanOut: async (tx, ownerId, eventId) => {
      await tx`INSERT INTO deliveries (owner_id, event_id, endpoint_id) VALUES (${ownerId}, ${eventId}, ${endpoint})`;
      throw failure;
    },
  })).rejects.toBe(failure);
  for (const table of ["events", "deliveries"]) {
    const [row] = await f.sql`SELECT count(*)::int AS count FROM ${f.sql(table)} WHERE owner_id = ${a.owner.id}`;
    expect(row!.count).toBe(0);
  }
});
