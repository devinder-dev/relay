import { afterAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { conflict } from "./errors.ts";

const app = buildApp(loadConfig({}), { logger: false });

// Test-only routes that fail on purpose, one for each kind of error.
app.get("/test/zod", async () => z.object({ name: z.string() }).parse({}));
app.get("/test/conflict", async () => {
  throw conflict("already_delivered", "This delivery was already delivered");
});
app.get("/test/crash", async () => {
  throw new Error("connection failed: password=hunter2");
});
app.post("/test/echo", async (request) => request.body);

afterAll(() => app.close());

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
});
