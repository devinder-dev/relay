// Checks that foreign ids and deliberately inconsistent joins cannot reveal another owner.
import { expect, test } from "bun:test";
import { eventsFixture } from "./events-fixture.ts";

const f = eventsFixture();
// Step 1: normalize only the per-request id when comparing otherwise identical 404 bodies.
const publicError = (res: { json(): any; headers: Record<string, unknown> }) => {
  const body = res.json();
  expect(body.error.request_id).toBe(res.headers["x-request-id"]);
  return { ...body, error: { ...body.error, request_id: "request-specific" } };
};
test("B cannot list, filter for or read A's deliveries; malformed ids have the same 404", async () => {
  const a = await f.owner(), b = await f.owner();
  const endpoint = await f.endpoint(a.owner.id);
  await f.post(a.key);
  const [row] = await f.sql`SELECT id FROM deliveries WHERE owner_id = ${a.owner.id}`;
  expect((await f.get(b.key)).json()).toEqual({ data: [], next_cursor: null });
  expect((await f.get(b.key, `/v1/deliveries?endpoint_id=${endpoint}`)).json())
    .toEqual({ data: [], next_cursor: null });
  const foreign = await f.get(b.key, `/v1/deliveries/${row!.id}`);
  const missing = await f.get(b.key, `/v1/deliveries/${crypto.randomUUID()}`);
  const malformed = await f.get(b.key, "/v1/deliveries/not-a-uuid");
  for (const res of [foreign, missing, malformed]) expect(res.statusCode).toBe(404);
  expect(publicError(foreign)).toEqual(publicError(missing));
  expect(publicError(malformed)).toEqual(publicError(missing));
  expect(missing.json().error.code).toBe("not_found");
  expect(missing.json().error.message).toBe("Delivery not found");
});
// Step 2: single-column foreign keys permit inconsistent ownership, so joins must enforce it.
test("foreign event and foreign endpoint joins are hidden in both list and detail", async () => {
  const a = await f.owner(), b = await f.owner();
  const aEndpoint = await f.endpoint(a.owner.id), bEndpoint = await f.endpoint(b.owner.id);
  const aEvent = (await f.post(a.key)).json().id, bEvent = (await f.post(b.key)).json().id;
  const planted: string[] = [];
  for (const [event, endpoint] of [[aEvent, bEndpoint], [bEvent, aEndpoint]]) {
    const [row] = await f.sql`INSERT INTO deliveries (owner_id, event_id, endpoint_id)
      VALUES (${b.owner.id}, ${event}, ${endpoint}) RETURNING id`;
    planted.push(row!.id);
  }
  const list = await f.get(b.key);
  expect(list.json().data).toHaveLength(1);
  for (const id of planted) {
    expect(list.json().data.some((d: { id: string }) => d.id === id)).toBe(false);
    expect((await f.get(b.key, `/v1/deliveries/${id}`)).statusCode).toBe(404);
  }
});
