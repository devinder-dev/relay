// Runs one claimed try, signs at send time and finalizes it with the lease token.
import type { Sql } from "../db.ts";
import { finalizeAttempt, finalizeDeleted, type ClaimedRow } from "../repositories/queue.ts";
import { retryDelayMs, type WorkerConfig } from "./config.ts";
import type { WorkerLog } from "./log.ts";
import { systemClock, type Clock, type SendResult, type WebhookInput } from "./send.ts";
import { buildBody, signatureHeaders } from "./sign.ts";

export type Send = (input: WebhookInput) => Promise<SendResult>;
export type ProcessDeps = {
  db: Sql; config: Pick<WorkerConfig, "RETRY_SCHEDULE" | "RETRY_JITTER" | "maxTries">;
  send: Send; log: WorkerLog; clock?: Clock;
};
// Step 1: a deleted endpoint consumes no HTTP request and creates no history row.
export async function processDelivery(row: ClaimedRow, deps: ProcessDeps) {
  const clock = deps.clock ?? systemClock;
  if (row.deleted_at) {
    const outcome = await finalizeDeleted(deps.db, { deliveryId: row.id, leaseId: row.lease_id });
    deps.log(outcome === "lease_lost" ? "warn" : "info", outcome === "lease_lost" ? "⚠️ lease_lost" : "✅ endpoint deleted", {
      delivery_id: row.id, lease_id: row.lease_id, outcome,
    });
    return;
  }
  // Step 2: construct bytes once; the fresh signature covers precisely those bytes.
  const body = buildBody({ type: row.type, createdAt: row.event_created_at, payload: row.payload });
  const headers = signatureHeaders({ secret: row.signing_secret, eventId: row.event_id, body,
    nowSeconds: Math.floor(clock.now().getTime() / 1000) });
  const attempt = await deps.send({ url: row.url, body, headers });
  const delivered = attempt.statusCode !== null && attempt.statusCode >= 200 && attempt.statusCode < 300;
  const status = delivered ? "delivered" : row.attempts >= deps.config.maxTries ? "dead" : "pending";
  const next = new Date(clock.now().getTime() + (status === "pending"
    ? retryDelayMs(deps.config.RETRY_SCHEDULE, row.attempts, deps.config.RETRY_JITTER) : 0));
  // Step 3: never retry an ambiguous commit; the loop logs failures and the lease recovers.
  const outcome = await finalizeAttempt(deps.db, { deliveryId: row.id, leaseId: row.lease_id, attempt, state: { status, next } });
  deps.log(outcome === "lease_lost" ? "warn" : "info", outcome === "lease_lost" ? "⚠️ lease_lost" : "✅ delivery attempt finished", {
    delivery_id: row.id, event_id: row.event_id, endpoint_id: row.endpoint_id, lease_id: row.lease_id,
    attempt: row.attempts, status_code: attempt.statusCode, error: attempt.error, duration_ms: attempt.durationMs,
    outcome: outcome === "lease_lost" ? outcome : status,
  });
}
