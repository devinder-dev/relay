// Drives the queue with bounded error pauses, a progress heartbeat and an interruptible stop.
import { claimDeliveries, exhaustDeliveries } from "../repositories/queue.ts";
import { BATCH, LEASE_SECONDS } from "./config.ts";
import { errorCode } from "./log.ts";
import { processDelivery, type ProcessDeps } from "./process.ts";
import { systemClock } from "./send.ts";

// Step 1: stopping wakes idle/error pauses, but already claimed work must finish.
export function createStop() {
  const controller = new AbortController();
  const ready = Promise.withResolvers<void>();
  return { signal: controller.signal, promise: ready.promise, stop: () => { controller.abort(); ready.resolve(); } };
}
export type Stop = ReturnType<typeof createStop>;
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}
export type LoopDeps = ProcessDeps & {
  stop: Stop; heartbeat: { last: number }; activeLeases: Map<string, string>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>; batch?: number; leaseSeconds?: number;
};
export async function runLoop(deps: LoopDeps): Promise<void> {
  const clock = deps.clock ?? systemClock, sleep = deps.sleep ?? pause;
  let errors = 0;
  // Step 2: each completed turn reports progress, even during a database outage.
  while (!deps.stop.signal.aborted) {
    deps.heartbeat.last = clock.monotonic();
    try {
      await exhaustDeliveries(deps.db, deps.config.maxTries);
      if (deps.stop.signal.aborted) break;
      const rows = await claimDeliveries(deps.db, { batch: deps.batch ?? BATCH,
        leaseSeconds: deps.leaseSeconds ?? LEASE_SECONDS, maxTries: deps.config.maxTries });
      errors = 0;
      for (const row of rows) deps.activeLeases.set(row.id, row.lease_id);
      if (!rows.length) await sleep(500, deps.stop.signal);
      else {
        const results = await Promise.allSettled(rows.map(async (row) => {
          try { await processDelivery(row, deps); } finally { deps.activeLeases.delete(row.id); }
        }));
        results.forEach((result, index) => {
          if (result.status === "rejected") deps.log("error", "❌ delivery attempt failed to finish", {
            delivery_id: rows[index]!.id, lease_id: rows[index]!.lease_id, code: errorCode(result.reason),
          });
        });
      }
    } catch (error) {
      deps.log("warn", "⚠️ queue unavailable, retrying", { code: errorCode(error) });
      await sleep(Math.min(5000, 1000 * 2 ** Math.min(errors++, 3)), deps.stop.signal);
    }
    deps.heartbeat.last = clock.monotonic();
  }
}
