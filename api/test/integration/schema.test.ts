// Schema v1 (migration 001), against the real Postgres: what it must accept (the positive
// controls) and what it must refuse, each with the right SQLSTATE. Every test runs in a
// transaction that is rolled back, so nothing is left behind.
import { afterAll, describe, expect, test } from "bun:test";
import { expectRefused, inRollback, testDb, type Tx } from "./helpers.ts";

const sql = testDb();
afterAll(() => sql.end({ timeout: 5 }));

type Seed = { ownerId: string; endpointId: string; eventId: string; deliveryId: string };

// A Postgres text[] literal with n event types, for example '{t1,t2}'.
const eventTypes = (n: number) => `{${Array.from({ length: n }, (_, i) => `t${i + 1}`).join(",")}}`;

// One valid row in every table, so a case can point at rows that exist.
async function seed(tx: Tx): Promise<Seed> {
  const [owner] = await tx`insert into owners (name) values ('Test owner') returning id`;
  const ownerId: string = owner!.id;
  await tx`
    insert into api_keys (owner_id, prefix, key_hash)
    values (${ownerId}, 'relay_live_test', sha256(convert_to('relay_live_test_full_key', 'UTF8')))`;
  const [endpoint] = await tx`
    insert into endpoints (owner_id, name, url, signing_secret)
    values (${ownerId}, 'Test endpoint', 'https://example.com/hook', 'whsec_test')
    returning id`;
  const [event] = await tx`
    insert into events (owner_id, type, payload, idempotency_key)
    values (${ownerId}, 'order.created', ${tx.json({ order_id: 1 })}, 'key-1')
    returning id`;
  const [delivery] = await tx`
    insert into deliveries (owner_id, event_id, endpoint_id)
    values (${ownerId}, ${event!.id}, ${endpoint!.id})
    returning id`;
  await tx`
    insert into attempts (delivery_id, started_at, duration_ms, status_code)
    values (${delivery!.id}, now(), 120, 200)`;
  return { ownerId, endpointId: endpoint!.id, eventId: event!.id, deliveryId: delivery!.id };
}

describe("schema v1 accepts valid rows (positive controls)", () => {
  test("one valid row in every table, with the defaults filled in", async () => {
    await inRollback(sql, async (tx) => {
      const ids = await seed(tx);
      const [delivery] = await tx`select status, attempts from deliveries where id = ${ids.deliveryId}`;
      expect(delivery).toEqual({ status: "pending", attempts: 0 });
      const [endpoint] = await tx`select event_types, deleted_at from endpoints where id = ${ids.endpointId}`;
      expect(endpoint).toEqual({ event_types: ["*"], deleted_at: null });
    });
  });

  test("two events without an idempotency key are BOTH accepted (NULLs never collide in a UNIQUE)", async () => {
    await inRollback(sql, async (tx) => {
      const { ownerId } = await seed(tx);
      await tx`insert into events (owner_id, type, payload) values (${ownerId}, 'a.b', ${tx.json({})})`;
      await tx`insert into events (owner_id, type, payload) values (${ownerId}, 'a.b', ${tx.json({})})`;
      const [row] = await tx`select count(*)::int as n from events where owner_id = ${ownerId} and idempotency_key is null`;
      expect(row!.n).toBe(2);
    });
  });

  test("the same idempotency key for two different owners is accepted (the UNIQUE is per owner)", async () => {
    await inRollback(sql, async (tx) => {
      await seed(tx); // owner 1 already used 'key-1'
      const [other] = await tx`insert into owners (name) values ('Other owner') returning id`;
      await tx`
        insert into events (owner_id, type, payload, idempotency_key)
        values (${other!.id}, 'order.created', ${tx.json({})}, 'key-1')`;
    });
  });

  test("the limits themselves are accepted: 20 event types, a 255-character idempotency key", async () => {
    // The positive controls for the "21" and "256" cases below: they prove those are refused
    // because of the limit, not because something else in the row is wrong.
    await inRollback(sql, async (tx) => {
      const { ownerId } = await seed(tx);
      await tx`
        insert into endpoints (owner_id, name, url, signing_secret, event_types)
        values (${ownerId}, 'x', 'https://example.com/hook', 'whsec_x', ${eventTypes(20)})`;
      await tx`
        insert into events (owner_id, type, payload, idempotency_key)
        values (${ownerId}, 'a.b', ${tx.json({})}, ${"k".repeat(255)})`;
    });
  });

  test("deleting an owner deletes everything that belongs to it (ON DELETE CASCADE)", async () => {
    await inRollback(sql, async (tx) => {
      const ids = await seed(tx);
      await tx`delete from owners where id = ${ids.ownerId}`;
      const [left] = await tx`
        select (select count(*) from api_keys   where owner_id = ${ids.ownerId})::int as api_keys,
               (select count(*) from endpoints  where owner_id = ${ids.ownerId})::int as endpoints,
               (select count(*) from events     where owner_id = ${ids.ownerId})::int as events,
               (select count(*) from deliveries where owner_id = ${ids.ownerId})::int as deliveries,
               (select count(*) from attempts   where delivery_id = ${ids.deliveryId})::int as attempts`;
      expect(left).toEqual({ api_keys: 0, endpoints: 0, events: 0, deliveries: 0, attempts: 0 });
    });
  });
});

// Each case: what it is, the SQLSTATE the database must answer, and the query. It runs after
// seed(), in its own rolled-back transaction, so `ids` points at rows that exist.
//   23514 a CHECK refused it   23505 a duplicate in a UNIQUE   23503 the referenced row doesn't exist
type Case = { what: string; sqlstate: string; query: (sql: Tx, ids: Seed) => Promise<unknown> };

const refused: Case[] = [
  // A worked example:
  {
    what: "an owner with an empty name",
    sqlstate: "23514",
    query: (sql) => sql`insert into owners (name) values ('')`,
  },
  {
    what: "an event with a non-object JSON payload",
    sqlstate: "23514",
    query: (sql, ids) => sql`insert into events (owner_id, type, payload) values (${ids.ownerId}, 'a.b', ${sql.json([1, 2])})`,
  },
  {
    what: "an event with a type that breaks the pattern",
    sqlstate: "23514",
    query: (sql, ids) => sql`insert into events (owner_id, type, payload) values (${ids.ownerId}, 'Order.created', ${sql.json({})})`,
  },
  {
    what: "an event with an idempotency key this owner already used",
    sqlstate: "23505",
    query: (sql, ids) => sql`insert into events (owner_id, type, payload, idempotency_key) values (${ids.ownerId}, 'a.b', ${sql.json({})}, 'key-1')`,
  },
  {
    what: "a delivery with an unknown status",
    sqlstate: "23514",
    query: (sql, ids) => sql`update deliveries set status = 'unknown' where id = ${ids.deliveryId}`,
  },
  {
    what: "a delivery for an event that doesn't exist",
    sqlstate: "23503",
    query: (sql, ids) => sql`insert into deliveries (owner_id, event_id, endpoint_id) values (${ids.ownerId}, '00000000-0000-0000-0000-000000000000', ${ids.endpointId})`,
  },
  {
    what: "a delivery for an endpoint that doesn't exist",
    sqlstate: "23503",
    query: (sql, ids) => sql`insert into deliveries (owner_id, event_id, endpoint_id) values (${ids.ownerId}, ${ids.eventId}, '00000000-0000-0000-0000-000000000000')`,
  },
  {
    what: "an attempt for a delivery that doesn't exist",
    sqlstate: "23503",
    query: (sql, ids) => sql`insert into attempts (delivery_id, started_at, duration_ms, status_code) values ('00000000-0000-0000-0000-000000000000', now(), 100, 200)`,
  },
  // Added after the review of #26: one case per remaining rule in migration 001.
  {
    what: "a second delivery of the same event to the same endpoint (the fan-out must not double)",
    sqlstate: "23505",
    query: (sql, ids) => sql`insert into deliveries (owner_id, event_id, endpoint_id) values (${ids.ownerId}, ${ids.eventId}, ${ids.endpointId})`,
  },
  {
    what: "an API key with a hash that already exists",
    sqlstate: "23505",
    query: (sql, ids) => sql`insert into api_keys (owner_id, prefix, key_hash) values (${ids.ownerId}, 'relay_live_copy', sha256(convert_to('relay_live_test_full_key', 'UTF8')))`,
  },
  {
    what: "an event without a type (a required value missing)",
    sqlstate: "23502",
    query: (sql, ids) => sql`insert into events (owner_id, payload) values (${ids.ownerId}, ${sql.json({})})`,
  },
  {
    what: "an endpoint with 0 event types",
    sqlstate: "23514",
    query: (sql, ids) => sql`insert into endpoints (owner_id, name, url, signing_secret, event_types) values (${ids.ownerId}, 'x', 'https://example.com/hook', 'whsec_x', '{}')`,
  },
  {
    what: "an endpoint with 21 event types (the limit is 20)",
    sqlstate: "23514",
    query: (sql, ids) => sql`insert into endpoints (owner_id, name, url, signing_secret, event_types) values (${ids.ownerId}, 'x', 'https://example.com/hook', 'whsec_x', ${eventTypes(21)})`,
  },
  {
    what: "an idempotency key of 256 characters (the limit is 255)",
    sqlstate: "23514",
    query: (sql, ids) => sql`insert into events (owner_id, type, payload, idempotency_key) values (${ids.ownerId}, 'a.b', ${sql.json({})}, ${"k".repeat(256)})`,
  },
];

describe("schema v1 refuses what breaks its rules, each with the right SQLSTATE", () => {
  for (const c of refused) {
    test(`${c.what} → ${c.sqlstate}`, async () => {
      await inRollback(sql, async (tx) => {
        const ids = await seed(tx);
        await expectRefused(tx, c.sqlstate, (sp) => c.query(sp, ids));
      });
    });
  }

  test("the list covers every kind of rule: CHECK, UNIQUE, foreign key and NOT NULL", () => {
    const kinds = new Set(refused.map((c) => c.sqlstate));
    for (const sqlstate of ["23514", "23505", "23503", "23502"]) {
      expect(kinds.has(sqlstate)).toBe(true);
    }
  });
});
