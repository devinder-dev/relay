// Stores events and retrieves the original answer for an owner's retry key.
import type postgres from "postgres";
import { AppError } from "../errors.ts";
import type { EventInput } from "../schemas/events.ts";

type Tx = postgres.TransactionSql;
type EventRow = { id: string; type: string; created_at: Date };

// Step 1: the unique constraint chooses the winner, including concurrent requests.
export async function insertEvent(tx: Tx, ownerId: string, input: EventInput, key?: string): Promise<EventRow | null> {
  try {
    const [row] = await tx<EventRow[]>`
      INSERT INTO events (owner_id, type, payload, idempotency_key)
      VALUES (${ownerId}, ${input.type}, ${tx.json(input.payload as postgres.JSONValue)}, ${key ?? null})
      ON CONFLICT (owner_id, idempotency_key) DO NOTHING RETURNING id, type, created_at`;
    return row ?? null;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "22P05" || code === "22P02") {
      throw new AppError(422, "validation_failed", "Request validation failed", [
        { path: "payload", message: "Payload contains characters that can't be stored" },
      ]);
    }
    throw error;
  }
}

// Step 2: a separate statement sees the winning transaction under READ COMMITTED.
export async function findEventByKey(tx: Tx, ownerId: string, key: string) {
  const [row] = await tx<(EventRow & { deliveries: number })[]>`
    SELECT e.id, e.type, e.created_at, count(d.id)::int AS deliveries
    FROM events e LEFT JOIN deliveries d ON d.event_id = e.id AND d.owner_id = e.owner_id
    WHERE e.owner_id = ${ownerId} AND e.idempotency_key = ${key}
    GROUP BY e.id, e.type, e.created_at`;
  return row ?? null;
}
