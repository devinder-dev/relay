// Checks replay responses, conflict precedence, authentication and unchanged refused rows.
import { expect, test } from "bun:test";
import { replayFixture } from "./deliveries-replay-fixture.ts";

const f = replayFixture();
// Step 1: the response is the existing list shape, captured after reset inside the transaction.
test("dead replay returns exactly Delivery, resets the lease and keeps the last HTTP status", async () => {
  const a = await f.seed({ lease: "live" });
  const before = Date.now();
  const res = await f.replay(a.key, a.id);
  expect(res.statusCode).toBe(202);
  const body = res.json();
  expect(body).toEqual({
    id: a.id, status: "pending", attempts: 0, next_attempt_at: expect.any(String), last_status_code: 503,
    last_error: null, delivered_at: null, created_at: a.createdAt.toISOString(),
    event: { id: a.eventId, type: "invoice.paid" }, endpoint: { id: a.endpointId, name: "Accounting webhook" },
  });
  expect(Date.parse(body.next_attempt_at)).toBeGreaterThanOrEqual(before - 1000);
  expect(Date.parse(body.next_attempt_at)).toBeLessThanOrEqual(Date.now() + 1000);
  const stored = await f.row(a.owner.id, a.id);
  expect(stored.status).toBe(body.status); expect(stored.attempts).toBe(body.attempts);
  expect(stored.next_attempt_at.toISOString()).toBe(body.next_attempt_at);
  expect(stored.last_error).toBe(body.last_error); expect(stored.last_status_code).toBe(503);
  expect(stored.lease_id).toBeNull();
  expect((await f.get(a.key)).json().data[0]).toEqual(body);
});
for (const lease of ["none", "expired"] as const) {
  test(`pending replay with ${lease} lease becomes due now`, async () => {
    const a = await f.seed({ status: "pending", lease });
    const res = await f.replay(a.key, a.id, {});
    expect(res.statusCode).toBe(202);
    expect(res.json().attempts).toBe(0);
    expect(Math.abs(Date.parse(res.json().next_attempt_at) - Date.now())).toBeLessThan(2000);
    expect((await f.row(a.owner.id, a.id)).lease_id).toBeNull();
  });
}
test("request fields are ignored and no body is required", async () => {
  const a = await f.seed();
  for (const body of [undefined, {}, { status: "delivered", attempts: 99 }]) {
    const res = await f.replay(a.key, a.id, body);
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe("pending"); expect(res.json().attempts).toBe(0);
  }
});
// Step 2: the decision order is delivered, deleted endpoint, then a live lease.
const conflicts = [
  [{ status: "pending", lease: "live" }, "in_flight", "This delivery is being sent right now, try again in a moment"],
  [{ status: "delivered" }, "already_delivered", "This delivery was already delivered"],
  [{ deleted: true }, "endpoint_deleted", "This delivery's endpoint was deleted"],
  [{ status: "pending", lease: "live", deleted: true }, "endpoint_deleted", "This delivery's endpoint was deleted"],
  [{ status: "delivered", deleted: true }, "already_delivered", "This delivery was already delivered"],
] as const;
for (const [options, code, message] of conflicts) {
  test(`${JSON.stringify(options)} refuses ${code} without changing the row`, async () => {
    const a = await f.seed(options), before = await f.row(a.owner.id, a.id);
    const res = await f.replay(a.key, a.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toEqual({ code, message, request_id: res.headers["x-request-id"] });
    expect(await f.row(a.owner.id, a.id)).toEqual(before);
  });
}
test("replay requires a valid API key", async () => {
  const a = await f.seed(), before = await f.row(a.owner.id, a.id);
  const res = await f.app.inject({ method: "POST", url: `/v1/deliveries/${a.id}/replay` });
  expect(res.statusCode).toBe(401); expect(res.json().error.code).toBe("unauthorized");
  expect(await f.row(a.owner.id, a.id)).toEqual(before);
});
