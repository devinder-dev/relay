// Starts the worker, handles signals before startup and bounds draining on shutdown.
import { createDb, waitForDatabase } from "../db.ts";
import { realLookup } from "../ssrf.ts";
import { DRAIN_MS, loadWorkerConfig } from "./config.ts";
import { startHealth } from "./health.ts";
import { createStop, runLoop } from "./loop.ts";
import { createLog, errorCode, type WorkerLog } from "./log.ts";
import { sendWebhook } from "./send.ts";

// Step 1: install handlers before waiting for a connection or opening a health port.
const stop = createStop();
const activeLeases = new Map<string, string>();
let log: WorkerLog = createLog("info");
let drainTimer: ReturnType<typeof setTimeout> | undefined;
function signal() {
  if (stop.signal.aborted) return;
  stop.stop();
  log("info", "✅ worker stopping");
  drainTimer = setTimeout(() => {
    log("error", "❌ worker drain deadline exceeded", { lease_ids: [...activeLeases.values()] });
    process.exit(1);
  }, DRAIN_MS);
}
process.on("SIGTERM", signal);
process.on("SIGINT", signal);
let db: ReturnType<typeof createDb> | undefined;
let health: ReturnType<typeof startHealth> | undefined;
try {
  const config = loadWorkerConfig();
  log = createLog(config.LOG_LEVEL);
  db = createDb(config);
  const databaseLog = {
    info: (fields: object, msg: string) => log("info", msg, { ...fields }),
    warn: (fields: object, msg: string) => log("warn", msg, { ...fields }),
  };
  await Promise.race([waitForDatabase(db, databaseLog), stop.promise]);
  if (!stop.signal.aborted) {
    // Step 2: health starts only after the database answers once; outages remain recoverable.
    const heartbeat = { last: performance.now() };
    health = startHealth(config.HEALTH_PORT, heartbeat);
    log("info", "✅ worker ready", { health_port: health.port });
    await runLoop({ db, config, log, stop, heartbeat, activeLeases,
      send: (input) => sendWebhook(input, { lookup: realLookup, allowOrigins: config.SSRF_ALLOW_ORIGINS,
        logCode: (code) => log("warn", "⚠️ unclassified send error", { code }) }) });
  }
  clearTimeout(drainTimer);
  health?.stop(true);
  // Startup cancellation has no in-flight work and closes a pending connection immediately.
  await db.end({ timeout: health ? 5 : 0 });
  process.exit(0);
} catch (error) {
  log("fatal", "❌ worker startup or loop failed", { code: errorCode(error) });
  health?.stop(true);
  await db?.end({ timeout: 0 });
  process.exit(1);
}
