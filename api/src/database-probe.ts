// A low-cost query proves that Relay's own database credentials and query path still work even
// when no customer requests arrive. It deliberately does not change Kubernetes health semantics.
import type { Sql } from "./db.ts";
import type { Metrics } from "./metrics.ts";

export type DatabaseProbeLog = { warn(fields: object, message: string): void };

export type DatabaseProbeOptions = { intervalMs?: number; timeoutMs?: number };

// One unresolved driver query is enough to diagnose an outage. Do not start another one: a
// Promise timeout cannot cancel postgres.js work, and repeatedly racing it would consume the
// application's small connection pool. A timeout marks the exported gauge unhealthy immediately,
// but the in-flight flag remains set until the original query actually settles.
export function createDatabaseProbe(
  query: () => Promise<unknown>, metrics: Metrics, log: DatabaseProbeLog,
  { intervalMs = 30_000, timeoutMs = 5_000 }: DatabaseProbeOptions = {},
) {
  let stopped = false, inFlight = false, finished = false, timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const run = () => {
    if (stopped || inFlight) return false;
    inFlight = true; finished = false; timedOut = false;

    // Start through a microtask so a synchronous throw is treated like a failed query.
    Promise.resolve().then(query).then(
      () => {
        finished = true;
        if (!timedOut) metrics.recordDatabaseQuery(true);
      },
      (error: unknown) => {
        finished = true;
        if (!timedOut) {
          metrics.recordDatabaseQuery(false);
          // Do not log the database URL, query result, or driver internals: these can expose secrets.
          log.warn({ error_type: error instanceof Error ? error.name : "unknown" }, "database monitoring query failed");
        }
      },
    ).finally(() => {
      clearTimeout(timeout);
      inFlight = false;
    });

    timeout = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      metrics.recordDatabaseQuery(false);
      log.warn({ error_type: "probe_timeout" }, "database monitoring query timed out");
    }, timeoutMs);
    return true;
  };

  const timer = setInterval(run, intervalMs);
  run();
  return {
    run,
    isInFlight: () => inFlight,
    // Do not await a stuck query during shutdown. sql.end({ timeout: 5 }) retains the existing
    // bounded process shutdown behavior; this only prevents future probe starts.
    stop: () => { stopped = true; clearInterval(timer); },
  };
}

export function startDatabaseProbe(sql: Sql, metrics: Metrics, log: DatabaseProbeLog, options?: DatabaseProbeOptions) {
  return createDatabaseProbe(async () => { await sql`SELECT 1`; }, metrics, log, options);
}
