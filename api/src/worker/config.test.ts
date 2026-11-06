// Checks duration limits, retry arithmetic and worker-specific defaults.
import { expect, test } from "bun:test";
import { loadWorkerConfig, parseSchedule, retryDelayMs } from "./config.ts";

const DATABASE_URL = "postgres://relay:test@127.0.0.1:55432/relay";
// Step 1: configuration cannot introduce unbounded waits or an invalid retry budget.
test("worker defaults and explicit overrides", () => {
  const config = loadWorkerConfig({ DATABASE_URL });
  expect(config.RETRY_SCHEDULE).toEqual([5, 60, 300, 1800, 7200, 21600, 43200]);
  expect(config.maxTries).toBe(8);
  expect(config.DB_POOL_MAX).toBe(3);
  expect(config.RETRY_JITTER).toBe(0.2);
  expect(config.HEALTH_PORT).toBe(9090);
  expect(loadWorkerConfig({ DATABASE_URL, RETRY_SCHEDULE: "1s,24h", RETRY_JITTER: "0" }).maxTries).toBe(3);
});
for (const raw of ["0s", "25h", "5x", "", "1s,", " 5s", "1e2s", "9".repeat(400) + "h", Array(21).fill("1s").join(",")]) {
  test(`rejects schedule ${raw.slice(0, 30)}`, () => expect(() => parseSchedule(raw)).toThrow());
}
test("jitter is finite and bounded, and edge random values give exact delay edges", () => {
  for (const value of ["-0.1", "0.6", "NaN", "Infinity", ""]) {
    expect(() => loadWorkerConfig({ DATABASE_URL, RETRY_JITTER: value })).toThrow();
  }
  expect(retryDelayMs([5, 60], 1, 0.2, () => 0)).toBe(4000);
  expect(retryDelayMs([5, 60], 2, 0.2, () => 1)).toBeCloseTo(72000, 6);
});
