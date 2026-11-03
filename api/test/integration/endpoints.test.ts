// Checks endpoint creation, validation, owner separation and safe failure responses.
import { expect, test } from "bun:test";
import { endpointFixture } from "./endpoints-fixture.ts";

const f = endpointFixture();
// Step 1: create returns the secret once, while lists expose only public fields.
test("201 creates an active endpoint and GET hides its signing secret", async () => {
  const a = await f.owner();
  const res = await f.post(a.key);
  expect(res.statusCode).toBe(201);
  const e = res.json();
  expect(e.signing_secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
  expect(e.event_types).toEqual(["*"]);
  expect(e.status).toBe("active");
  expect(new Date(e.created_at).toISOString()).toBe(e.created_at);
  const listed = await f.list(a.key);
  expect(listed.statusCode).toBe(200);
  const { signing_secret, ...publicFields } = e;
  expect(listed.json()).toEqual({ data: [publicFields] });
  expect(listed.body).not.toContain("signing_secret");
  expect(listed.body).not.toContain(signing_secret);
});
test("event arrays round-trip after removing duplicates", async () => {
  const a = await f.owner();
  const res = await f.post(a.key, { event_types: ["invoice.paid", "*", "invoice.paid", "order.created"] });
  expect(res.statusCode).toBe(201);
  expect(res.json().event_types).toEqual(["invoice.paid", "*", "order.created"]);
  expect((await f.list(a.key)).json().data[0].event_types).toEqual(["invoice.paid", "*", "order.created"]);
});

// Step 2: invalid bodies and destinations must use the one public error shape.
for (const input of [{ extra: true }, { name: "x".repeat(101) }]) {
  test(`invalid body ${Object.keys(input)[0]} returns 422 validation_failed`, async () => {
    const a = await f.owner();
    const res = await f.post(a.key, input);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("validation_failed");
  });
}
test("http URL returns 422 invalid_endpoint_url", async () => {
  const a = await f.owner();
  const res = await f.post(a.key, { url: "http://example.com/" });
  expect(res.statusCode).toBe(422);
  expect(res.json().error.code).toBe("invalid_endpoint_url");
});
test("private DNS returns 422 invalid_endpoint_url", async () => {
  const a = await f.owner();
  f.setLookup(async () => ["10.0.0.5"]);
  try {
    const res = await f.post(a.key);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("invalid_endpoint_url");
  } finally { f.setLookup(async () => ["93.184.215.14"]); }
});
test("requests without a key return 401", async () => {
  for (const method of ["GET", "POST"] as const) {
    expect((await f.app.inject({ method, url: "/v1/endpoints" })).statusCode).toBe(401);
  }
});
test("owner B cannot list owner A's endpoint", async () => {
  const a = await f.owner(), b = await f.owner();
  expect((await f.post(a.key)).statusCode).toBe(201);
  const res = await f.list(b.key);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ data: [] });
});

// Step 3: an owner deleted after DNS must not leave a row or leak the generated secret.
test("failure after DNS saves nothing and never logs a signing secret", async () => {
  const a = await f.owner();
  f.setLookup(async () => {
    await f.sql`DELETE FROM owners WHERE id = ${a.owner.id}`;
    return ["93.184.215.14"];
  });
  const start = f.lines.length;
  try {
    const res = await f.post(a.key);
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("internal_error");
    expect(res.body).not.toContain("whsec_");
    expect(f.lines.slice(start).join("")).not.toContain("whsec_");
    const [row] = await f.sql`SELECT count(*)::int AS count FROM endpoints WHERE owner_id = ${a.owner.id}`;
    expect(row?.count).toBe(0);
  } finally { f.setLookup(async () => ["93.184.215.14"]); }
});
