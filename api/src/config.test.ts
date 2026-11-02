import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";

// DATABASE_URL is required, so every test passes one. It's never connected to here.
const DB = { DATABASE_URL: "postgres://test@localhost/test" };

describe("loadConfig", () => {
  test("uses safe defaults when nothing else is set", () => {
    expect(loadConfig(DB)).toEqual({
      PORT: 8080,
      GIT_SHA: "dev",
      LOG_LEVEL: "info",
      DATABASE_URL: "postgres://test@localhost/test",
      DB_POOL_MAX: 5,
    });
  });

  test("turns PORT from text into a number", () => {
    expect(loadConfig({ ...DB, PORT: "3000" }).PORT).toBe(3000);
  });

  test("refuses a PORT that is not a valid port", () => {
    expect(() => loadConfig({ ...DB, PORT: "banana" })).toThrow(/PORT/);
    expect(() => loadConfig({ ...DB, PORT: "70000" })).toThrow(/PORT/);
    expect(() => loadConfig({ ...DB, PORT: "3000abc" })).toThrow(/PORT/);
    expect(() => loadConfig({ ...DB, PORT: "80.5" })).toThrow(/PORT/);
  });

  test("refuses an unknown LOG_LEVEL", () => {
    expect(() => loadConfig({ ...DB, LOG_LEVEL: "loud" })).toThrow(/LOG_LEVEL/);
  });

  test("stops at once without DATABASE_URL, or with one that isn't postgres://", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: "mysql://test@localhost/test" })).toThrow(/DATABASE_URL/);
    expect(loadConfig({ DATABASE_URL: "postgresql://test@localhost/test" }).DATABASE_URL).toStartWith("postgresql://");
  });

  test("DB_POOL_MAX: a whole number from 1 to 20", () => {
    expect(loadConfig({ ...DB, DB_POOL_MAX: "8" }).DB_POOL_MAX).toBe(8);
    for (const bad of ["0", "21", "2.5", "five"]) {
      expect(() => loadConfig({ ...DB, DB_POOL_MAX: bad })).toThrow(/DB_POOL_MAX/);
    }
  });
});
