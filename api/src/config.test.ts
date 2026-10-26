import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";

describe("loadConfig", () => {
  test("uses safe defaults when nothing is set", () => {
    expect(loadConfig({})).toEqual({ PORT: 8080, GIT_SHA: "dev", LOG_LEVEL: "info" });
  });

  test("turns PORT from text into a number", () => {
    expect(loadConfig({ PORT: "3000" }).PORT).toBe(3000);
  });

  test("refuses a PORT that is not a valid port", () => {
    expect(() => loadConfig({ PORT: "banana" })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: "70000" })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: "3000abc" })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: "80.5" })).toThrow(/PORT/);
  });

  test("refuses an unknown LOG_LEVEL", () => {
    expect(() => loadConfig({ LOG_LEVEL: "loud" })).toThrow(/LOG_LEVEL/);
  });
});
