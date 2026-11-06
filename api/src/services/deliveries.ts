// Maps database rows to public delivery pages and delivery history.
import type { Sql } from "../db.ts";
import { conflict, notFound } from "../errors.ts";
import * as repository from "../repositories/deliveries.ts";

// Step 1: explicitly map public fields, including nullable values and ISO timestamps.
function delivery(row: repository.DeliveryRow) {
  return {
    id: row.id, status: row.status, attempts: row.attempts,
    next_attempt_at: row.next_attempt_at?.toISOString() ?? null,
    last_status_code: row.last_status_code, last_error: row.last_error,
    delivered_at: row.delivered_at?.toISOString() ?? null, created_at: row.created_at.toISOString(),
    event: { id: row.event_id, type: row.event_type },
    endpoint: { id: row.endpoint_id, name: row.endpoint_name },
  };
}
export async function listDeliveries(sql: Sql, ownerId: string, filters: repository.DeliveryFilters) {
  const rows = await repository.listDeliveries(sql, ownerId, filters);
  const data = rows.slice(0, filters.limit).map(delivery);
  return { data, next_cursor: rows.length > filters.limit ? data.at(-1)!.id : null };
}

// Step 2: a missing or foreign delivery has one answer; history never reveals secret fields.
export async function getDelivery(sql: Sql, ownerId: string, id: string) {
  const row = await repository.getDelivery(sql, ownerId, id);
  if (!row) throw notFound("Delivery");
  const attempts = await repository.listAttempts(sql, ownerId, id);
  return {
    ...delivery(row),
    event: { id: row.event_id, type: row.event_type, payload: row.payload, created_at: row.event_created_at.toISOString() },
    endpoint: { id: row.endpoint_id, name: row.endpoint_name, url: row.endpoint_url },
    attempt_log: attempts.map((a) => ({
      id: a.id, number: a.number, started_at: a.started_at.toISOString(), duration_ms: a.duration_ms,
      status_code: a.status_code, error: a.error, response_excerpt: a.response_excerpt,
    })),
  };
}

// Step 3: check conflicts in contract order while holding only this owner's delivery lock.
export async function replayDelivery(sql: Sql, ownerId: string, id: string) {
  return sql.begin(async (tx) => {
    const row = await repository.lockForReplay(tx, ownerId, id);
    if (!row) throw notFound("Delivery");
    if (row.status === "delivered") throw conflict("already_delivered", "This delivery was already delivered");
    if (row.endpoint_deleted) throw conflict("endpoint_deleted", "This delivery's endpoint was deleted");
    if (row.in_flight) throw conflict("in_flight", "This delivery is being sent right now, try again in a moment");
    await repository.replayDelivery(tx, ownerId, id);
    // Read before commit: a worker could otherwise claim it first and make the answer show attempts 1.
    const replayed = await repository.getDeliveryRow(tx, ownerId, id);
    if (!replayed) throw new Error("Replayed delivery could not be read");
    return delivery(replayed);
  });
}
