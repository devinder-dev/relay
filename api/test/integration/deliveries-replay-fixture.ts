// Gives replay tests isolated owners and SQL-seeded delivery states without network calls.
import { eventsFixture } from "./events-fixture.ts";

export function replayFixture() {
  const f = eventsFixture();
  // Step 1: each case starts with a fresh owner so list responses contain only its row.
  async function seed(options: {
    status?: "pending" | "delivered" | "dead"; lease?: "none" | "expired" | "live"; deleted?: boolean;
  } = {}) {
    const a = await f.owner();
    const endpointId = await f.endpoint(a.owner.id);
    const [event] = await f.sql`INSERT INTO events (owner_id, type, payload)
      VALUES (${a.owner.id}, 'invoice.paid', '{"invoice":42}') RETURNING id`;
    const lease = options.lease ?? "none", status = options.status ?? "dead";
    const next = new Date(Date.now() + (lease === "expired" ? -60_000 : 3_600_000));
    const [row] = await f.sql`INSERT INTO deliveries (owner_id, event_id, endpoint_id, status, attempts,
      lease_id, next_attempt_at, last_status_code, last_error, delivered_at)
      VALUES (${a.owner.id}, ${event!.id}, ${endpointId}, ${status}, 8,
        ${lease === "none" ? null : crypto.randomUUID()}, ${next}, 503, 'connect_failed',
        ${status === "delivered" ? new Date() : null}) RETURNING id, created_at`;
    if (options.deleted) await f.sql`UPDATE endpoints SET deleted_at = now()
      WHERE owner_id = ${a.owner.id} AND id = ${endpointId}`;
    return { ...a, id: row!.id as string, createdAt: row!.created_at as Date, endpointId, eventId: event!.id as string };
  }
  // Step 2: both the no-body and JSON-body paths use the real auth and error handlers.
  function replay(key: string, id: string, body?: object) {
    return f.app.inject({ method: "POST", url: `/v1/deliveries/${id}/replay`,
      headers: { authorization: `Bearer ${key}` }, ...(body === undefined ? {} : { payload: body }) });
  }
  async function row(ownerId: string, id: string) {
    return (await f.sql`SELECT * FROM deliveries WHERE owner_id = ${ownerId} AND id = ${id}`)[0]!;
  }
  return { ...f, seed, replay, row };
}
