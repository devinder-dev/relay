// Checks the app through HTTP injection without connecting to a database.
import { afterAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createDb } from "./db.ts";
import { AppError, conflict } from "./errors.ts";

// A harmless database URL: these tests never connect to it.
const sql = createDb(loadConfig({ DATABASE_URL: "postgres://relay:x@127.0.0.1:1/relay" }));
const app = buildApp(loadConfig({ DATABASE_URL: "postgres://test@localhost/test" }), { sql }, { logger: false });

// Test-only routes that fail on purpose, one for each kind of error.
app.get("/test/zod", async () => z.object({ name: z.string() }).parse({}));
app.get("/test/conflict", async () => {
  throw conflict("already_delivered", "This delivery was already delivered");
});
app.get("/test/crash", async () => {
  throw new Error("connection failed: password=hunter2");
});
app.post("/test/echo", async (request) => request.body);
// What postgres.js throws when Postgres is down, and when our own SQL is wrong.
app.get("/test/db-down", async () => {
  throw Object.assign(new Error("connect ECONNREFUSED 10.43.0.5:5432"), { code: "ECONNREFUSED" });
});
app.get("/test/db-bug", async () => {
  throw Object.assign(new Error('relation "nope" does not exist'), { code: "42P01" });
});

// Step 1: details remain public only when deliberately supplied by application code.
app.get("/test/details", async () => {
  throw new AppError(422, "validation_failed", "Invalid input", [{ path: "name", message: "Required" }]);
});

afterAll(async () => {
  await app.close();
  await sql.end({ timeout: 5 });
});

describe("error handler", () => {
  test("unknown route → 404 not_found, in our error shape", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    expect(res.json().error.request_id).toBe(res.headers["x-request-id"]);
  });

  test("Zod error → 422 validation_failed, naming the wrong field", async () => {
    const res = await app.inject({ method: "GET", url: "/test/zod" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("validation_failed");
    expect(res.json().error.details).toEqual([{ path: "name", message: expect.any(String) }]);
  });

  test("our own AppError → its own status and code", async () => {
    const res = await app.inject({ method: "GET", url: "/test/conflict" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("already_delivered");
  });

  test("broken JSON → 400 bad_request", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/test/echo",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_request");
  });

  test("body that isn't JSON → 415 unsupported_media_type", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/test/echo",
      headers: { "content-type": "application/xml" },
      payload: "<event/>",
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe("unsupported_media_type");
  });

  test("body over 256 KiB → 413 payload_too_large", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/test/echo",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ data: "x".repeat(300 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("payload_too_large");
  });

  test("unexpected crash → 500 internal_error, and the details are NOT leaked", async () => {
    const res = await app.inject({ method: "GET", url: "/test/crash" });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("internal_error");
    expect(res.body).not.toContain("hunter2");
  });

  test("database unreachable → 503 service_unavailable with Retry-After, no address leaked", async () => {
    const res = await app.inject({ method: "GET", url: "/test/db-down" });
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("5");
    expect(res.json().error.code).toBe("service_unavailable");
    expect(res.json().error.request_id).toBe(res.headers["x-request-id"]);
    expect(res.body).not.toContain("10.43.0.5");
  });

  test("a database error that is our bug (no such table) → still 500, never hidden as an outage", async () => {
    const res = await app.inject({ method: "GET", url: "/test/db-bug" });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("internal_error");
  });
});

// Step 2: the default text parser must not bypass the JSON-only contract.
for (const contentType of ["text/plain", undefined]) {
  test(`echo rejects ${contentType ?? "missing content type"}`, async () => {
    const res = await app.inject({
      method: "POST", url: "/test/echo", payload: "hello",
      headers: contentType ? { "content-type": contentType } : {},
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe("unsupported_media_type");
  });
}
test("JSON with a charset passes", async () => {
  const res = await app.inject({ method: "POST", url: "/test/echo",
    headers: { "content-type": "application/json; charset=utf-8" }, payload: '{"ok":true}' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
});
test("AppError carries deliberately supplied details", async () => {
  const res = await app.inject({ method: "GET", url: "/test/details" });
  expect(res.statusCode).toBe(422);
  expect(res.json().error.details).toEqual([{ path: "name", message: "Required" }]);
});

// Step 3: a database row or JSON payload must never reach the log stream.
test("Postgres error logs contain the code without secret detail or where", async () => {
  const lines: string[] = [];
  const logged = buildApp(loadConfig({ DATABASE_URL: "postgres://relay:x@127.0.0.1:1/relay" }), { sql },
    { logStream: { write: (line) => { lines.push(line); } } });
  logged.get("/test/pg-secret", async () => {
    throw Object.assign(new Error("CHECK failed"), {
      name: "PostgresError", code: "23514", severity: "ERROR",
      detail: "Failing row contains (MARKER_SECRET_123)", where: "payload MARKER_SECRET_123",
      hint: "MARKER_SECRET_123", internal_query: "MARKER_SECRET_123",
    });
  });
  try {
    const res = await logged.inject({ method: "GET", url: "/test/pg-secret" });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("internal_error");
    expect(lines.join("")).toContain("23514");
    expect(lines.join("")).not.toContain("MARKER_SECRET_123");
  } finally {
    await logged.close();
  }
});
