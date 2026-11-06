// Validates worker settings and bounds the retry budget and operational deadlines.
import { z } from "zod";
import { AllowOrigins } from "../config.ts";

export const BATCH = 5; // Five concurrent sends keep finalization queues small.
export const LEASE_SECONDS = 60; // A crashed worker's rows become due after a minute.
export const SEND_DEADLINE_MS = 10_000; // DNS and HTTP share one absolute deadline.
export const DNS_TIMEOUT_MS = 3_000; // Resolution cannot use the whole send budget.
export const EXCERPT_BYTES = 1_024; // Only the first KiB of a response is stored.
export const DRAIN_MS = 20_000; // Leave time for pool closure inside the pod's grace period.
export const HEARTBEAT_STALE_MS = 30_000; // A stuck loop eventually fails liveness.

// Step 1: durations have one spelling and a finite, useful range after conversion.
export function parseSchedule(text: string): number[] {
  const items = text.split(",");
  if (items.length < 1 || items.length > 20) throw new Error("Retry schedule needs 1–20 waits");
  return items.map((item) => {
    if (!/^\d+(s|m|h)$/.test(item)) throw new Error("Retry waits must be digits followed by s, m or h");
    const seconds = Number(item.slice(0, -1)) * ({ s: 1, m: 60, h: 3600 }[item.at(-1)!] ?? 0);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86_400) {
      throw new Error("Retry waits must be between 1 second and 24 hours");
    }
    return seconds;
  });
}
export function retryDelayMs(schedule: number[], attempts: number, jitter: number, random = Math.random): number {
  const seconds = schedule[attempts - 1];
  if (seconds === undefined) throw new Error("No retry wait for this attempt");
  return seconds * 1000 * (1 - jitter + 2 * jitter * random());
}
const integer = (fallback: number, max: number) => z.string().regex(/^\d+$/).transform(Number)
  .pipe(z.number().int().min(1).max(max)).default(fallback);
const Env = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//),
  DB_POOL_MAX: integer(3, 20),
  SSRF_ALLOW_ORIGINS: AllowOrigins,
  RETRY_SCHEDULE: z.string().default("5s,1m,5m,30m,2h,6h,12h").transform((text, ctx) => {
    try { return parseSchedule(text); } catch (error) {
      ctx.addIssue({ code: "custom", message: (error as Error).message }); return z.NEVER;
    }
  }),
  RETRY_JITTER: z.string().min(1).transform(Number).pipe(z.number().min(0).max(0.5)).default(0.2),
  HEALTH_PORT: integer(9090, 65535),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  GIT_SHA: z.string().default("dev"),
});
export type WorkerConfig = z.infer<typeof Env> & { maxTries: number };
// Step 2: fail at startup, before any work is claimed.
export function loadWorkerConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  const result = Env.safeParse(env);
  if (!result.success) throw new Error(`Invalid worker configuration:\n${z.prettifyError(result.error)}`);
  return { ...result.data, maxTries: result.data.RETRY_SCHEDULE.length + 1 };
}
