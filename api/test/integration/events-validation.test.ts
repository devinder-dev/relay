// Checks invalid event envelopes, retry headers, JSON characters and HTTP limits.
import { beforeAll, expect, test } from "bun:test";
import { eventsFixture } from "./events-fixture.ts";

const f = eventsFixture();
let key: string;
beforeAll(async () => { key = (await f.owner()).key; });
// Step 1: each validation failure identifies its public input field.
const cases: [string, unknown, string][] = [
  ["uppercase type", { type: "Invoice.Paid", payload: {} }, "type"],
  ["empty type", { type: "", payload: {} }, "type"],
  ["long type", { type: "a".repeat(101), payload: {} }, "type"],
  ["array payload", { type: "test", payload: [] }, "payload"],
  ["null payload", { type: "test", payload: null }, "payload"],
  ["string payload", { type: "test", payload: "x" }, "payload"],
  ["missing payload", { type: "test" }, "payload"],
  ["unknown envelope field", { type: "test", payload: {}, extra: true }, ""],
  ["NUL value", { type: "test", payload: { value: "\u0000" } }, "payload"],
  ["NUL key", { type: "test", payload: { "\u0000": "x" } }, "payload"],
  ["nested NUL", { type: "test", payload: { nested: [{ value: "\u0000" }] } }, "payload"],
  ["high surrogate", { type: "test", payload: { value: "\ud800" } }, "payload"],
  ["low surrogate", { type: "test", payload: { value: "\udc00" } }, "payload"],
];
for (const [name, body, path] of cases) {
  test(name + " gives 422 with the field path", async () => {
    const res = await f.post(key, body);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("validation_failed");
    expect(res.json().error.details.some((d: { path: string }) => d.path === path)).toBe(true);
  });
}
for (const retryKey of ["a".repeat(256), "bad\tkey", ""]) {
  test(`invalid retry key ${JSON.stringify(retryKey)} identifies idempotency-key`, async () => {
    const res = await f.post(key, undefined, retryKey);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("validation_failed");
    expect(res.json().error.details[0].path).toBe("idempotency-key");
  });
}
// Step 2: ordinary Unicode and boundary lengths remain valid.
test("emoji round-trips and a 255-character key is accepted", async () => {
  const a = await f.owner();
  const res = await f.post(a.key, { type: "test", payload: { value: "😀" } }, "a".repeat(255));
  expect(res.statusCode).toBe(202);
  const [row] = await f.sql`SELECT payload FROM events WHERE owner_id = ${a.owner.id} AND id = ${res.json().id}`;
  expect(row!.payload).toEqual({ value: "😀" });
});
test("event route enforces body size, JSON media type and authentication", async () => {
  const large = await f.post(key, { type: "test", payload: { value: "x".repeat(256 * 1024) } });
  expect(large.statusCode).toBe(413);
  expect(large.json().error.code).toBe("payload_too_large");
  const text = await f.app.inject({ method: "POST", url: "/v1/events", payload: "hello",
    headers: { authorization: `Bearer ${key}`, "content-type": "text/plain" } });
  expect(text.statusCode).toBe(415);
  expect(text.json().error.code).toBe("unsupported_media_type");
  const noKey = await f.app.inject({ method: "POST", url: "/v1/events", payload: { type: "test", payload: {} } });
  expect(noKey.statusCode).toBe(401);
});
