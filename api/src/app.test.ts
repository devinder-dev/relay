import { afterAll, describe, expect, test } from "bun:test";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";

// A config made from a fixed object, so the test never depends on this machine's environment.
const app = buildApp(loadConfig({ GIT_SHA: "abc123" }), { logger: false });
afterAll(() => app.close());

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
