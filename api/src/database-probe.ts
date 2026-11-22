// A low-cost query proves that Relay's own database credentials and query path still work even
// when no customer requests arrive. It deliberately does not change Kubernetes health semantics.
import type { Sql } from "./db.ts";
import type { Metrics } from "./metrics.ts";

export type DatabaseProbeLog = { warn(fields: object, message: string): void };

export async function checkDatabase(query: () => Promise<unknown>, metrics: Metrics, log: DatabaseProbeLog) {
  try {
    await query();
    metrics.recordDatabaseQuery(true);
  } catch (error) {
    // Do not log the database URL, query result, or driver internals: these can expose secrets.
    metrics.recordDatabaseQuery(false);
    log.warn({ error_type: error instanceof Error ? error.name : "unknown" }, "database monitoring query failed");
  }
}

export function startDatabaseProbe(sql: Sql, metrics: Metrics, log: DatabaseProbeLog, intervalMs = 30_000) {
  const run = () => checkDatabase(async () => { await sql`SELECT 1`; }, metrics, log);
  void run();
  const timer = setInterval(() => { void run(); }, intervalMs);
  return { stop: () => clearInterval(timer), run };
}
