// Checks keyset pages, combined filters and strict query validation through HTTP.
import { beforeAll, expect, test } from "bun:test";
import { deliveriesFixture } from "./deliveries-fixture.ts";

const f = deliveriesFixture();
let a: Awaited<ReturnType<typeof f.seed>>;
beforeAll(async () => { a = await f.seed(); });
// Step 1: the cursor is the last row sent, never the extra row fetched.
test("five rows page newest first as 2, 2, 1 with no gaps or duplicates", async () => {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (const expected of [[f.id(5), f.id(4)], [f.id(3), f.id(2)], [f.id(1)]]) {
    const res = await f.get(a.key, `/v1/deliveries?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.map((d: { id: string }) => d.id)).toEqual(expected);
    cursor = body.next_cursor;
    expect(cursor).toBe(expected.length === 2 ? expected.at(-1)! : null);
    ids.push(...body.data.map((d: { id: string }) => d.id));
  }
  expect(new Set(ids).size).toBe(5);
  const defaults = await f.get(a.key);
  expect(defaults.json().data).toHaveLength(5);
  expect(defaults.json().next_cursor).toBeNull();
});
test("status, endpoint and both filters select only the requested rows", async () => {
  for (const [query, ids] of [
    ["status=dead", [f.id(2), f.id(1)]],
    [`endpoint_id=${a.endpoint}`, [f.id(5), f.id(3), f.id(1)]],
    [`status=dead&endpoint_id=${a.endpoint}`, [f.id(1)]],
  ] as [string, string[]][]) {
    const res = await f.get(a.key, `/v1/deliveries?${query}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((d: { id: string }) => d.id)).toEqual(ids);
  }
});
// Step 2: text that Number() alone would accept must fail before SQL.
for (const query of ["limit=0", "limit=101", "limit=abc", "limit=", "limit=1e2", "limit=%205",
  "status=lost", "cursor=x", "unknown=1", "endpoint_id=x"]) {
  test(`invalid query ${query} gives validation_failed`, async () => {
    const res = await f.get(a.key, `/v1/deliveries?${query}`);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("validation_failed");
  });
}
