// Exercises authentication against real Postgres, cleaning up only this file's owners.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { buildApp } from "../../src/app.ts";
import { generateApiKey, hashApiKey } from "../../src/auth/api-key.ts";
import { loadConfig } from "../../src/config.ts";
import { createOwnerWithKey } from "../../src/services/owners.ts";
import { DATABASE_URL, testDb } from "./helpers.ts";
import { rawMe } from "./auth-socket.ts";

// Step 1: create isolated fixtures and keep their ids for cleanup even after a failure.
const sql = testDb();
const deadSql = testDb({ url: "postgres://relay:x@127.0.0.1:1/relay" });
const lines: string[] = [];
const logStream = { write: (line: string) => { lines.push(line); } };
const config = loadConfig({ DATABASE_URL });
const app = buildApp(config, { sql }, { logStream });
const unavailable = buildApp(config, { sql: deadSql }, { logStream });
type Created = Awaited<ReturnType<typeof createOwnerWithKey>>;
let a: Created, b: Created, revoked: Created;
const ids: string[] = [];
let port: number;
beforeAll(async () => {
  for (const label of ["A", "B", "revoked"]) {
    const created = await createOwnerWithKey(sql, `auth-${label}-${crypto.randomUUID()}`);
    ids.push(created.owner.id);
    if (label === "A") a = created;
    else if (label === "B") b = created;
    else revoked = created;
  }
  await sql`UPDATE api_keys SET revoked_at = now() WHERE owner_id = ${revoked.owner.id}`;
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP address");
  port = address.port;
});
afterAll(async () => {
  try {
    await Promise.all([app.close(), unavailable.close()]);
    if (ids.length) await sql`DELETE FROM owners WHERE id IN ${sql(ids)}`;
  } finally {
    await Promise.all([sql.end({ timeout: 5 }), deadSql.end({ timeout: 5 })]);
  }
});

// Step 2: a valid key reveals only its own owner and the public key prefix.
test("fresh key returns its owner and prefix without the full key", async () => {
  const res = await app.inject({ url: "/v1/me", headers: { authorization: `Bearer ${a.key}` } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ owner: a.owner, key: { prefix: a.prefix } });
  expect(res.body.includes(a.key)).toBe(false);
});
test("owner B's key returns B, not A", async () => {
  const res = await app.inject({ url: "/v1/me", headers: { authorization: `Bearer ${b.key}` } });
  expect(res.statusCode).toBe(200);
  expect(res.json().owner).toEqual(b.owner);
  expect(res.json().owner.id).not.toBe(a.owner.id);
});
test("unknown, revoked, missing and Basic keys have the same 401", async () => {
  const errors = [];
  for (const header of [`Bearer ${generateApiKey().key}`, `Bearer ${revoked.key}`, undefined, "Basic abc"]) {
    const res = await app.inject({ url: "/v1/me", headers: header ? { authorization: header } : {} });
    expect(res.statusCode).toBe(401);
    const { code, message } = res.json().error;
    errors.push({ code, message });
  }
  expect(errors).toEqual(Array(4).fill({ code: "unauthorized", message: "A valid API key is required" }));
});
test("SHA-256 agrees with Postgres UTF-8 hashing", async () => {
  const [row] = await sql`SELECT sha256(convert_to(${a.key}, 'UTF8')) AS hash`;
  expect(row?.hash.equals(hashApiKey(a.key))).toBe(true);
});
test("two Authorization headers over a real socket return 401", async () => {
  expect(await rawMe(port, [a.key, b.key])).toBe(401);
});
test("one Authorization header over a real socket returns 200", async () => {
  expect(await rawMe(port, [a.key])).toBe(200);
});
test("closed database port returns 503 and Retry-After", async () => {
  const res = await unavailable.inject({ url: "/v1/me", headers: { authorization: `Bearer ${a.key}` } });
  expect(res.statusCode).toBe(503);
  expect(res.json().error.code).toBe("service_unavailable");
  expect(res.headers["retry-after"]).toBe("5");
});
test("logs of a 200, 401 and 503 never contain the full key", async () => {
  const start = lines.length;
  const ok = await app.inject({ url: "/v1/me", headers: { authorization: `Bearer ${a.key}` } });
  const denied = await app.inject({ url: "/v1/me", headers: { authorization: `Basic ${a.key}` } });
  const down = await unavailable.inject({ url: "/v1/me", headers: { authorization: `Bearer ${a.key}` } });
  const log = lines.slice(start).join("");
  expect(log.length).toBeGreaterThan(0);
  expect(log.includes(a.key)).toBe(false);
  expect([ok.statusCode, denied.statusCode, down.statusCode]).toEqual([200, 401, 503]);
});

// Step 3: the root not-found handler stays public, as do health and version.
test("unknown v1 paths return 404 and operational routes remain open", async () => {
  expect((await app.inject({ url: "/v1/unknown" })).statusCode).toBe(404);
  for (const url of ["/health/live", "/health/ready", "/version"]) {
    expect((await app.inject({ url })).statusCode).toBe(200);
  }
});
