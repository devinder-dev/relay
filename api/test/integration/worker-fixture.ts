// Seeds only this test file's owners and local destinations, with cascading cleanup.
import { afterAll } from "bun:test";
import { createOwnerWithKey } from "../../src/services/owners.ts";
import { generateSigningSecret } from "../../src/services/endpoints.ts";
import { claimDeliveries } from "../../src/repositories/queue.ts";
import { loadWorkerConfig } from "../../src/worker/config.ts";
import { DATABASE_URL, testDb } from "./helpers.ts";

export function workerFixture() {
  const db = testDb({ poolMax: 10 });
  const owners: string[] = [];
  const config = loadWorkerConfig({ DATABASE_URL, RETRY_SCHEDULE: "1s,1s", RETRY_JITTER: "0" });
  afterAll(async () => {
    try { for (const id of owners) await db`DELETE FROM owners WHERE id = ${id}`; }
    finally { await db.end({ timeout: 5 }); }
  });
  // Step 1: fixture events deliberately share an endpoint to exercise delivery-only locks.
  async function seed(count = 1, url = "http://receiver.test/hooks", ownerId?: string) {
    if (!ownerId) { ownerId = (await createOwnerWithKey(db, `worker-${crypto.randomUUID()}`)).owner.id; owners.push(ownerId); }
    const secret = generateSigningSecret();
    const [ep] = await db`INSERT INTO endpoints (owner_id, name, url, signing_secret)
      VALUES (${ownerId}, 'Worker receiver', ${url}, ${secret}) RETURNING id`;
    const deliveries: string[] = [], events: string[] = [];
    for (let i = 0; i < count; i++) {
      const [ev] = await db`INSERT INTO events (owner_id, type, payload)
        VALUES (${ownerId}, 'demo.ping', '{}') RETURNING id`;
      const [d] = await db`INSERT INTO deliveries (owner_id, event_id, endpoint_id)
        VALUES (${ownerId}, ${ev!.id}, ${ep!.id}) RETURNING id`;
      deliveries.push(d!.id); events.push(ev!.id);
    }
    return { ownerId, endpointId: ep!.id as string, secret, deliveries, events };
  }
  const claim = (maxTries = 3, batch = 5) => claimDeliveries(db, { maxTries, batch, leaseSeconds: 60 });
  const row = async (id: string) => (await db`SELECT * FROM deliveries WHERE id = ${id}`)[0]!;
  const expire = (id: string) => db`UPDATE deliveries SET next_attempt_at = now() - interval '1 second' WHERE id = ${id}`;
  return { db, config, seed, claim, row, expire };
}
export const attempt = { startedAt: new Date(), durationMs: 12, statusCode: 200, error: null, excerpt: "ok" };
