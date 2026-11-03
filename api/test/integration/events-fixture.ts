// Gives event and delivery tests isolated owners, local HTTP injection and SQL setup.
import { afterAll, beforeAll } from "bun:test";
import { buildApp } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { createOwnerWithKey } from "../../src/services/owners.ts";
import { DATABASE_URL, testDb } from "./helpers.ts";

// Step 1: each calling file owns its database rows and removes them even after failures.
export function eventsFixture(poolMax = 5) {
  const sql = testDb({ poolMax });
  const owners: Awaited<ReturnType<typeof createOwnerWithKey>>[] = [];
  const app = buildApp(loadConfig({ DATABASE_URL }), { sql }, { logger: false });
  beforeAll(() => app.ready());
  afterAll(async () => {
    try {
      await app.close();
      for (const a of owners) await sql`DELETE FROM owners WHERE id = ${a.owner.id}`;
    } finally { await sql.end({ timeout: 5 }); }
  });
  async function owner() {
    const a = await createOwnerWithKey(sql, `events-${crypto.randomUUID()}`);
    owners.push(a);
    return a;
  }
  async function endpoint(ownerId: string, types = ["*"], deleted = false) {
    const [row] = await sql`
      INSERT INTO endpoints (owner_id, name, url, signing_secret, event_types, deleted_at)
      VALUES (${ownerId}, 'Accounting webhook', 'https://example.com/hook', 'test-only',
        ${sql.array(types)}, ${deleted ? new Date() : null}) RETURNING id`;
    return row!.id as string;
  }
  // Step 2: no outbound HTTP or DNS; requests run inside Fastify.
  function post(key: string, payload: unknown = { type: "invoice.paid", payload: {} }, retryKey?: string) {
    return app.inject({ method: "POST", url: "/v1/events", payload: payload as object,
      headers: { authorization: `Bearer ${key}`, ...(retryKey === undefined ? {} : { "idempotency-key": retryKey }) } });
  }
  function get(key: string, url = "/v1/deliveries") {
    return app.inject({ url, headers: { authorization: `Bearer ${key}` } });
  }
  return { sql, app, owner, endpoint, post, get };
}
