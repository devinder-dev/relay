// Checks public delivery fields, deleted endpoint history and numbered attempt logs.
import { beforeAll, expect, test } from "bun:test";
import { deliveriesFixture } from "./deliveries-fixture.ts";

const f = deliveriesFixture();
let a: Awaited<ReturnType<typeof f.seed>>;
beforeAll(async () => { a = await f.seed(); });
// Step 1: compare the contract example field by field, with this run's isolated ids.
test("list row has exactly the example's keys, types and values", async () => {
  const body = (await f.get(a.key)).json();
  const row = body.data[0];
  expect(row).toEqual({
    id: f.id(5), status: "pending", attempts: 3,
    next_attempt_at: "2026-10-25T14:09:30.000Z", last_status_code: 500,
    last_error: null, delivered_at: null, created_at: "2026-10-25T14:03:20.000Z",
    event: { id: expect.any(String), type: "invoice.paid" },
    endpoint: { id: a.endpoint, name: "Accounting webhook" },
  });
  expect(typeof row.attempts).toBe("number");
  expect(typeof row.last_status_code).toBe("number");
});
test("pending shows its stored time; dead and delivered hide it in list and detail", async () => {
  const rows = (await f.get(a.key)).json().data;
  for (const row of rows) {
    const expected = row.status === "pending" ? "2026-10-25T14:09:30.000Z" : null;
    expect(row.next_attempt_at).toBe(expected);
    const res = await f.get(a.key, `/v1/deliveries/${row.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().next_attempt_at).toBe(expected);
  }
});

// Step 2: chronological numbering breaks ties by id, independent of insertion order.
test("detail keeps payload, deleted endpoint and the full oldest-first attempt history", async () => {
  await f.sql`UPDATE endpoints SET deleted_at = now() WHERE owner_id = ${a.owner.id} AND id = ${a.endpoint}`;
  for (const [order, time, status, error, excerpt] of [
    [12, "2026-10-25T14:04:00Z", 500, null, "receiver failed"],
    [11, "2026-10-25T14:03:00Z", null, "timeout", null],
    [13, "2026-10-25T14:04:00Z", 200, null, "ok"],
  ] as const) {
    await f.sql`INSERT INTO attempts (id, delivery_id, started_at, duration_ms, status_code, error, response_excerpt)
      VALUES (${f.id(order)}, ${f.id(1)}, ${time}, 123, ${status}, ${error}, ${excerpt})`;
  }
  const res = await f.get(a.key, `/v1/deliveries/${f.id(1)}`);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
    id: f.id(1), status: "dead", attempts: 3, next_attempt_at: null,
    last_status_code: 500, last_error: null, delivered_at: null, created_at: "2026-10-25T14:03:20.000Z",
    event: { id: a.eventId, type: "invoice.paid", payload: { invoice: { total: 42 } }, created_at: "2026-10-25T14:03:19.000Z" },
    endpoint: { id: a.endpoint, name: "Accounting webhook", url: "https://example.com/hook" },
    attempt_log: [
      { id: f.id(11), number: 1, started_at: "2026-10-25T14:03:00.000Z", duration_ms: 123,
        status_code: null, error: "timeout", response_excerpt: null },
      { id: f.id(12), number: 2, started_at: "2026-10-25T14:04:00.000Z", duration_ms: 123,
        status_code: 500, error: null, response_excerpt: "receiver failed" },
      { id: f.id(13), number: 3, started_at: "2026-10-25T14:04:00.000Z", duration_ms: 123,
        status_code: 200, error: null, response_excerpt: "ok" },
    ],
  });
});
test("non-null completion fields remain present in list and detail", async () => {
  await f.sql`UPDATE deliveries SET delivered_at = '2026-10-25T14:05:00Z', last_status_code = 204
    WHERE owner_id = ${a.owner.id} AND id = ${f.id(3)}`;
  await f.sql`UPDATE deliveries SET last_status_code = NULL, last_error = 'endpoint_deleted'
    WHERE owner_id = ${a.owner.id} AND id = ${f.id(2)}`;
  const rows = (await f.get(a.key)).json().data;
  for (const id of [f.id(2), f.id(3)]) {
    const row = rows.find((r: { id: string }) => r.id === id);
    const detail = (await f.get(a.key, `/v1/deliveries/${id}`)).json();
    expect(detail.delivered_at).toBe(row.delivered_at);
    expect(detail.last_error).toBe(row.last_error);
    expect(detail.last_status_code).toBe(row.last_status_code);
  }
  expect(rows.find((r: { id: string }) => r.id === f.id(3)).delivered_at).toBe("2026-10-25T14:05:00.000Z");
  expect(rows.find((r: { id: string }) => r.id === f.id(2)).last_error).toBe("endpoint_deleted");
});
