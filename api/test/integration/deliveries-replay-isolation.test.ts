// Checks identical replay 404s for malformed, missing, foreign and inconsistent owned rows.
import { expect, test } from "bun:test";
import { replayFixture } from "./deliveries-replay-fixture.ts";

const f = replayFixture();
// Step 1: single-column foreign keys allow planted mismatches; owner joins must hide both.
test("all inaccessible delivery ids have the same error body and cannot reset a row", async () => {
  const a = await f.seed(), b = await f.seed();
  const planted: string[] = [];
  for (const [event, endpoint] of [[a.eventId, b.endpointId], [b.eventId, a.endpointId]] as const) {
    const [row] = await f.sql`INSERT INTO deliveries (owner_id, event_id, endpoint_id, status, attempts)
      VALUES (${b.owner.id}, ${event}, ${endpoint}, 'dead', 8) RETURNING id`;
    planted.push(row!.id);
  }
  const before = await f.row(a.owner.id, a.id);
  const bodies = [];
  for (const id of [crypto.randomUUID(), "not-a-uuid", a.id, ...planted]) {
    const res = await f.replay(b.key, id);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.request_id).toBe(res.headers["x-request-id"]);
    bodies.push({ ...res.json().error, request_id: "request-specific" });
  }
  expect(bodies).toEqual(Array(5).fill({ code: "not_found", message: "Delivery not found", request_id: "request-specific" }));
  expect(await f.row(a.owner.id, a.id)).toEqual(before);
  for (const id of planted) expect((await f.row(b.owner.id, id)).attempts).toBe(8);
});
