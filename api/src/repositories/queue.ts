// Claims owner-consistent work and records outcomes without letting stale leases change state.
import type postgres from "postgres";
import type { Sql } from "../db.ts";
import type { SendResult } from "../worker/send.ts";

type Db = Sql | postgres.TransactionSql;
export type ClaimedRow = {
  id: string; owner_id: string; lease_id: string; attempts: number; endpoint_id: string;
  event_id: string; type: string; payload: Record<string, unknown>; event_created_at: Date;
  url: string; signing_secret: string; deleted_at: Date | null;
};
export type DeliveryState = { status: "pending" | "delivered" | "dead"; next: Date };
export type FinalizeInput = { deliveryId: string; leaseId: string; attempt: SendResult; state: DeliveryState };

// Step 1: an expired last try becomes dead even if its worker never reached finalize.
export async function exhaustDeliveries(db: Db, maxTries: number): Promise<number> {
  const rows = await db`UPDATE deliveries SET status = 'dead', lease_id = NULL
    WHERE status = 'pending' AND next_attempt_at <= now() AND attempts >= ${maxTries}`;
  return rows.count;
}
export async function claimDeliveries(db: Db, options: { batch: number; leaseSeconds: number; maxTries: number }): Promise<ClaimedRow[]> {
  return db<ClaimedRow[]>`
    WITH due AS (
      SELECT d.id FROM deliveries d
      JOIN events e ON e.id = d.event_id AND e.owner_id = d.owner_id
      JOIN endpoints ep ON ep.id = d.endpoint_id AND ep.owner_id = d.owner_id
      WHERE d.status = 'pending' AND d.next_attempt_at <= now() AND d.attempts < ${options.maxTries}
      ORDER BY d.next_attempt_at, d.id LIMIT ${options.batch}
      FOR UPDATE OF d SKIP LOCKED)
    UPDATE deliveries d SET attempts = d.attempts + 1, lease_id = gen_random_uuid(),
      next_attempt_at = now() + make_interval(secs => ${options.leaseSeconds})
    FROM due, events e, endpoints ep
    WHERE d.id = due.id AND e.id = d.event_id AND e.owner_id = d.owner_id
      AND ep.id = d.endpoint_id AND ep.owner_id = d.owner_id
    RETURNING d.id, d.owner_id, d.lease_id, d.attempts, d.endpoint_id,
      e.id AS event_id, e.type, e.payload, e.created_at AS event_created_at,
      ep.url, ep.signing_secret, ep.deleted_at`;
}

// Step 2: history commits even after a lost lease; an INSERT error rolls everything back.
export async function finalizeAttempt(sql: Sql, input: FinalizeInput): Promise<"ok" | "lease_lost"> {
  return sql.begin(async (tx) => {
    const { attempt: a, state } = input;
    await tx`INSERT INTO attempts (delivery_id, started_at, duration_ms, status_code, error, response_excerpt)
      VALUES (${input.deliveryId}, ${a.startedAt}, ${a.durationMs}, ${a.statusCode}, ${a.error}, ${a.excerpt})`;
    const rows = await tx`UPDATE deliveries SET status = ${state.status}, next_attempt_at = ${state.next},
      lease_id = NULL, last_status_code = ${a.statusCode}, last_error = ${a.error},
      delivered_at = CASE WHEN ${state.status} = 'delivered' THEN now() ELSE delivered_at END
      WHERE id = ${input.deliveryId} AND lease_id = ${input.leaseId}`;
    return rows.count ? "ok" : "lease_lost";
  });
}
// Step 3: deleted endpoints are terminal without pretending an HTTP attempt happened.
export async function finalizeDeleted(db: Db, input: { deliveryId: string; leaseId: string }): Promise<"ok" | "lease_lost"> {
  const rows = await db`UPDATE deliveries SET status = 'dead', lease_id = NULL, next_attempt_at = now(),
    last_error = 'endpoint_deleted', last_status_code = NULL
    WHERE id = ${input.deliveryId} AND lease_id = ${input.leaseId}`;
  return rows.count ? "ok" : "lease_lost";
}
