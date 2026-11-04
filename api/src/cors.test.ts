// Checks browser preflights at the root without needing a database connection.
import { afterAll, expect, test } from "bun:test";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createDb } from "./db.ts";

const config = loadConfig({ DATABASE_URL: "postgres://relay:x@127.0.0.1:1/relay" });
const sql = createDb(config);
const app = buildApp(config, { sql }, { logger: false });
afterAll(async () => { await app.close(); await sql.end({ timeout: 5 }); });
const origin = "https://cdn.myrelay.tech";
// Step 1: a browser's unauthenticated preflight finishes before the v1 auth hook.
for (const allowed of [origin, "http://localhost:4173"]) {
  test(`preflight permits ${allowed} and the retry-key header`, async () => {
    const res = await app.inject({ method: "OPTIONS", url: "/v1/events", headers: {
      origin: allowed, "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type,idempotency-key",
    } });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(allowed);
    expect(res.headers["access-control-allow-headers"]).toContain("idempotency-key");
    expect(res.headers["access-control-max-age"]).toBe("600");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });
}
test("foreign preflight has no allow-origin header", async () => {
  const res = await app.inject({ method: "OPTIONS", url: "/v1/events", headers: {
    origin: "https://evil.example", "access-control-request-method": "POST",
  } });
  expect(res.headers["access-control-allow-origin"]).toBeUndefined();
});
test("OPTIONS without Origin is 204 without an allow-origin header", async () => {
  const res = await app.inject({ method: "OPTIONS", url: "/v1/events" });
  expect(res.statusCode).toBe(204);
  expect(res.headers["access-control-allow-origin"]).toBeUndefined();
});
// Step 2: browser code can read even an authentication failure.
test("401 includes the permitted origin and exposed response headers", async () => {
  const res = await app.inject({ url: "/v1/me", headers: { origin } });
  expect(res.statusCode).toBe(401);
  expect(res.headers["access-control-allow-origin"]).toBe(origin);
  for (const header of ["x-request-id", "retry-after", "idempotent-replayed"]) {
    expect(res.headers["access-control-expose-headers"]).toContain(header);
  }
});
test("health probes still answer without authentication", async () => {
  for (const url of ["/health/live", "/health/ready"]) {
    const res = await app.inject({ url });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  }
});
