// Fans events out and reads deliveries and attempts within their owner's boundary.
import type postgres from "postgres";
import type { Sql } from "../db.ts";

type Db = Sql | postgres.TransactionSql;

export type DeliveryRow = {
  id: string; status: "pending" | "delivered" | "dead"; attempts: number;
  next_attempt_at: Date | null; last_status_code: number | null; last_error: string | null;
  delivered_at: Date | null; created_at: Date;
  event_id: string; event_type: string; endpoint_id: string; endpoint_name: string;
};
export type DetailRow = DeliveryRow & {
  payload: Record<string, unknown>; event_created_at: Date; endpoint_url: string;
};
export type AttemptRow = {
  id: string; number: number; started_at: Date; duration_ms: number;
  status_code: number | null; error: string | null; response_excerpt: string | null;
};
export type DeliveryFilters = {
  status?: DeliveryRow["status"]; endpointId?: string; cursor?: string; limit: number;
};

// Step 1: column defaults create pending deliveries with no attempts.
export async function fanOut(tx: postgres.TransactionSql, ownerId: string, eventId: string, type: string) {
  const rows = await tx`
    INSERT INTO deliveries (owner_id, event_id, endpoint_id)
    SELECT ${ownerId}, ${eventId}, e.id FROM endpoints e
    WHERE e.owner_id = ${ownerId} AND e.deleted_at IS NULL
      AND (${type} = ANY(e.event_types) OR '*' = ANY(e.event_types))`;
  return rows.count;
}

// Step 2: the column is never NULL; during a lease it holds the lease's expiry.
// The API shows it only for pending deliveries. Both read queries share this rule.
const nextAttempt = (db: Db) => db`CASE WHEN d.status = 'pending' THEN d.next_attempt_at END AS next_attempt_at`;
const columns = (db: Db) => db`
  d.id, d.status, d.attempts, ${nextAttempt(db)}, d.last_status_code, d.last_error,
  d.delivered_at, d.created_at, ev.id AS event_id, ev.type AS event_type,
  e.id AS endpoint_id, e.name AS endpoint_name`;

export async function listDeliveries(db: Sql, ownerId: string, filters: DeliveryFilters): Promise<DeliveryRow[]> {
  const { status, endpointId, cursor, limit } = filters;
  return db<DeliveryRow[]>`
    SELECT ${columns(db)} FROM deliveries d
    JOIN events ev ON ev.id = d.event_id AND ev.owner_id = d.owner_id
    JOIN endpoints e ON e.id = d.endpoint_id AND e.owner_id = d.owner_id
    WHERE d.owner_id = ${ownerId}
      ${status ? db`AND d.status = ${status}` : db``}
      ${endpointId ? db`AND d.endpoint_id = ${endpointId}` : db``}
      ${cursor ? db`AND d.id < ${cursor}` : db``}
    ORDER BY d.id DESC LIMIT ${limit + 1}`;
}

// Step 3: deleted endpoints stay available in historical delivery details.
export async function getDelivery(db: Sql, ownerId: string, id: string): Promise<DetailRow | null> {
  const [row] = await db<DetailRow[]>`
    SELECT ${columns(db)}, ev.payload, ev.created_at AS event_created_at, e.url AS endpoint_url
    FROM deliveries d
    JOIN events ev ON ev.id = d.event_id AND ev.owner_id = d.owner_id
    JOIN endpoints e ON e.id = d.endpoint_id AND e.owner_id = d.owner_id
    WHERE d.owner_id = ${ownerId} AND d.id = ${id}`;
  return row ?? null;
}

export async function listAttempts(db: Sql, ownerId: string, deliveryId: string): Promise<AttemptRow[]> {
  return db<AttemptRow[]>`
    SELECT a.id, row_number() OVER (ORDER BY a.started_at, a.id)::int AS number,
      a.started_at, a.duration_ms, a.status_code, a.error, a.response_excerpt
    FROM attempts a JOIN deliveries d ON d.id = a.delivery_id AND d.owner_id = ${ownerId}
    WHERE a.delivery_id = ${deliveryId} ORDER BY a.started_at, a.id`;
}

// Step 4: the lock makes the replay decision and update one step. A worker claim skips it;
// an old worker finishing after replay finds its lease gone and changes no delivery state.
export async function lockForReplay(tx: postgres.TransactionSql, ownerId: string, id: string) {
  const [row] = await tx<{
    status: DeliveryRow["status"]; endpoint_deleted: boolean; in_flight: boolean;
  }[]>`
    SELECT d.status, (ep.deleted_at IS NOT NULL) AS endpoint_deleted,
      (d.status = 'pending' AND d.lease_id IS NOT NULL AND d.next_attempt_at > now()) AS in_flight
    FROM deliveries d
    JOIN events ev ON ev.id = d.event_id AND ev.owner_id = d.owner_id
    JOIN endpoints ep ON ep.id = d.endpoint_id AND ep.owner_id = d.owner_id
    WHERE d.owner_id = ${ownerId} AND d.id = ${id}
    FOR UPDATE OF d`;
  return row ?? null;
}

export async function replayDelivery(tx: postgres.TransactionSql, ownerId: string, id: string): Promise<void> {
  // The contract resets last_error only; last_status_code keeps the previous receiver answer.
  await tx`UPDATE deliveries
    SET status = 'pending', attempts = 0, next_attempt_at = now(), lease_id = NULL, last_error = NULL
    WHERE owner_id = ${ownerId} AND id = ${id}`;
}

export async function getDeliveryRow(db: Db, ownerId: string, id: string): Promise<DeliveryRow | null> {
  const [row] = await db<DeliveryRow[]>`
    SELECT ${columns(db)} FROM deliveries d
    JOIN events ev ON ev.id = d.event_id AND ev.owner_id = d.owner_id
    JOIN endpoints e ON e.id = d.endpoint_id AND e.owner_id = d.owner_id
    WHERE d.owner_id = ${ownerId} AND d.id = ${id}`;
  return row ?? null;
}
