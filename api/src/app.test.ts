// Checks the app through HTTP injection without connecting to a database.
import { afterAll, describe, expect, test } from "bun:test";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createDb } from "./db.ts";

// A config made from a fixed object, so the test never depends on this machine's environment.
// DATABASE_URL is required but harmless here: these tests never connect to it.
const sql = createDb(loadConfig({ DATABASE_URL: "postgres://relay:x@127.0.0.1:1/relay" }));
const app = buildApp(loadConfig({ GIT_SHA: "abc123", DATABASE_URL: "postgres://test@localhost/test" }), { sql }, {
  logger: false,
});
afterAll(async () => {
  await app.close();
  await sql.end({ timeout: 5 });
});

describe("health routes", () => {
  test("GET /health/live answers ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health/live" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  test("GET /health/ready answers ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  test("GET /version shows the commit that is running", async () => {
    const res = await app.inject({ method: "GET", url: "/version" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sha: "abc123" });
  });

  test("every response carries an x-request-id", async () => {
    const res = await app.inject({ method: "GET", url: "/health/live" });
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});
