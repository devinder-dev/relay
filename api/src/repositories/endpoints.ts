// Stores and lists endpoints with every read restricted to its owner.
import type postgres from "postgres";
import type { Sql } from "../db.ts";
import type { EndpointInput } from "../schemas/endpoints.ts";

type Tx = postgres.TransactionSql;
export type EndpointRow = {
  id: string; name: string; url: string; event_types: string[]; created_at: Date;
};
export type ListedEndpoint = EndpointRow & { status: "active" | "failing" };

// Step 1: creates of the same owner queue here; other owners do not wait.
export async function lockOwner(tx: Tx, ownerId: string): Promise<void> {
  await tx`SELECT 1 FROM owners WHERE id = ${ownerId} FOR UPDATE`;
}
export async function countLiveEndpoints(tx: Tx, ownerId: string): Promise<number> {
  const [row] = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count FROM endpoints WHERE owner_id = ${ownerId} AND deleted_at IS NULL`;
  return row!.count;
}
export async function insertEndpoint(tx: Tx, ownerId: string, input: EndpointInput, signingSecret: string): Promise<EndpointRow> {
  const [row] = await tx<EndpointRow[]>`
    INSERT INTO endpoints (owner_id, name, url, event_types, signing_secret)
    VALUES (${ownerId}, ${input.name}, ${input.url}, ${tx.array(input.event_types)}, ${signingSecret})
    RETURNING id, name, url, event_types, created_at`;
  if (!row) throw new Error("Endpoint insert returned no row");
  return row;
}

// Step 2: the newest delivery determines status. Ids are UUIDv7 (ordered by time), so id DESC
// is newest first and reads one row from deliveries_endpoint_id; sorting by created_at would
// read every delivery the endpoint ever had.
// This relies on Phase 4 raising attempts when a try has finished, not when claimed.
export async function listLiveEndpoints(db: Sql, ownerId: string): Promise<ListedEndpoint[]> {
  return db<ListedEndpoint[]>`
    SELECT e.id, e.name, e.url, e.event_types, e.created_at,
      CASE WHEN latest.status = 'dead' OR (latest.status = 'pending' AND latest.attempts > 0)
        THEN 'failing' ELSE 'active' END AS status
    FROM endpoints e
    LEFT JOIN LATERAL (
      SELECT d.status, d.attempts FROM deliveries d
      WHERE d.endpoint_id = e.id AND d.owner_id = e.owner_id
      ORDER BY d.id DESC LIMIT 1
    ) latest ON true
    WHERE e.owner_id = ${ownerId} AND e.deleted_at IS NULL
    ORDER BY e.created_at DESC, e.id DESC`;
}
