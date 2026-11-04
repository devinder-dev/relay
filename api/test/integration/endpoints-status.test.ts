// Checks that the newest delivery determines endpoint health and lists are newest first.
import { expect, test } from "bun:test";
import { endpointFixture } from "./endpoints-fixture.ts";

const f = endpointFixture();
// Step 1: each insert gets a later UUIDv7, so the last one inserted is the newest delivery.
test("newest dead, delivered and pending deliveries determine endpoint status", async () => {
  const a = await f.owner();
  const created = await f.post(a.key);
  expect(created.statusCode).toBe(201);
  const endpointId = created.json().id;
  for (const [status, attempts, code, expected] of [
    ["dead", 8, 500, "failing"], ["delivered", 1, 200, "active"],
    ["pending", 1, 500, "failing"], ["pending", 0, null, "active"],
  ] as const) {
    const [event] = await f.sql`INSERT INTO events (owner_id, type, payload)
      VALUES (${a.owner.id}, 'test.status', '{}'::jsonb) RETURNING id`;
    await f.sql`INSERT INTO deliveries (owner_id, event_id, endpoint_id, status, attempts, last_status_code)
      VALUES (${a.owner.id}, ${event!.id}, ${endpointId}, ${status}, ${attempts}, ${code})`;
    const listed = await f.list(a.key);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data[0].status).toBe(expected);
  }
});
// Step 2: deleted rows are hidden and creation order is deterministic.
test("lists live endpoints newest first", async () => {
  const a = await f.owner();
  const first = await f.post(a.key, { name: "First" });
  const second = await f.post(a.key, { name: "Second" });
  expect(first.statusCode).toBe(201);
  expect(second.statusCode).toBe(201);
  expect((await f.list(a.key)).json().data.map((e: { name: string }) => e.name)).toEqual(["Second", "First"]);
  await f.sql`UPDATE endpoints SET deleted_at = now() WHERE owner_id = ${a.owner.id} AND id = ${second.json().id}`;
  expect((await f.list(a.key)).json().data.map((e: { name: string }) => e.name)).toEqual(["First"]);
});
