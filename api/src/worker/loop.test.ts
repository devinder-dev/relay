// Drives a stale heartbeat and database-error backoff without real-time waits.
import { expect, test } from "bun:test";
import { createDb } from "../db.ts";
import { loadWorkerConfig } from "./config.ts";
import { startHealth } from "./health.ts";
import { createStop, runLoop } from "./loop.ts";
import { createLog } from "./log.ts";

// Step 1: error pauses still count as progress and stop without another database claim.
test("database errors back off, update the heartbeat, and stop", async () => {
  const config = loadWorkerConfig({ DATABASE_URL: "postgres://relay:test@127.0.0.1:1/relay" });
  const db = createDb(config); await db.end({ timeout: 0 });
  const stop = createStop(), heartbeat = { last: 0 }, waits: number[] = [], lines: string[] = [];
  let elapsed = 0;
  await runLoop({ db, config, stop, heartbeat, activeLeases: new Map(), send: async () => { throw new Error("Unexpected send"); },
    log: createLog("warn", (line) => lines.push(line)), clock: { now: () => new Date(), monotonic: () => elapsed },
    sleep: async (ms) => { waits.push(ms); elapsed += ms; if (waits.length === 5) stop.stop(); },
  });
  expect(waits).toEqual([1000, 2000, 4000, 5000, 5000]);
  expect(heartbeat.last).toBe(elapsed);
  expect(lines).toHaveLength(5);
  const health = startHealth(0, heartbeat, () => elapsed);
  try {
    const url = `http://127.0.0.1:${health.port}/health/live`;
    expect((await fetch(url)).status).toBe(200);
    elapsed += 30_001;
    expect((await fetch(url)).status).toBe(503);
    expect((await fetch(url.replace("/health/live", "/other"))).status).toBe(404);
  } finally { health.stop(true); }
});
test("logger honors its level without losing structured metadata", () => {
  const lines: string[] = [];
  const log = createLog("warn", (line) => lines.push(line));
  log("info", "✅ quiet"); log("warn", "⚠️ visible", { lease_id: "lease" });
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({ level: "warn", msg: "⚠️ visible", lease_id: "lease" });
});
