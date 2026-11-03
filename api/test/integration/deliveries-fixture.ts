// Seeds ordered delivery histories without depending on connection timing.
import { randomBytes } from "node:crypto";
import { eventsFixture } from "./events-fixture.ts";

// Step 1: order lives in the UUID prefix; a random tail avoids crashed-run collisions.
export function deliveriesFixture() {
  const f = eventsFixture();
  const tail = randomBytes(6).toString("hex");
  const id = (order: number) => `019000${order.toString(16).padStart(2, "0")}-0000-7000-8000-${tail}`;
  async function seed() {
    const a = await f.owner();
    const endpoint = await f.endpoint(a.owner.id), otherEndpoint = await f.endpoint(a.owner.id);
    const [event] = await f.sql`INSERT INTO events (owner_id, type, payload, created_at)
      VALUES (${a.owner.id}, 'invoice.paid', ${f.sql.json({ invoice: { total: 42 } })}, '2026-10-25T14:03:19Z') RETURNING id`;
    // Step 2: one event per endpoint pair; separate events let five deliveries share endpoints.
    for (let i = 1; i <= 5; i++) {
      const [ev] = i === 1 ? [event] : await f.sql`
        INSERT INTO events (owner_id, type, payload) VALUES (${a.owner.id}, 'invoice.paid', '{}') RETURNING id`;
      await f.sql`INSERT INTO deliveries
        (id, owner_id, event_id, endpoint_id, status, attempts, next_attempt_at, last_status_code, created_at)
        VALUES (${id(i)}, ${a.owner.id}, ${ev!.id}, ${i % 2 ? endpoint : otherEndpoint},
          ${i <= 2 ? "dead" : i === 3 ? "delivered" : "pending"}, 3,
          '2026-10-25T14:09:30Z', 500, '2026-10-25T14:03:20Z')`;
    }
    return { ...a, endpoint, otherEndpoint, eventId: event!.id as string };
  }
  return { ...f, id, seed };
}
