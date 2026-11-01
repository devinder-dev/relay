// Shared by the integration tests: the real Postgres from `bun run db:up`, logged in as relay.
import type postgres from "postgres";
import { loadConfig } from "../../src/config.ts";
import { createDb, type Log, type Sql } from "../../src/db.ts";

// Step 1: no database → stop with a clear message. Never skip: a broken CI setup would then
// skip the most important tests and still show green.
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL is missing. The integration tests need the test database: run `bun run db:up`, " +
      "then `bun run test:db`. (`bun run test:unit` runs only the unit tests, without a database.)",
  );
}
export const DATABASE_URL: string = url;

// A pool with production's own settings (createDb), exactly as the API uses it.
export function testDb(databaseUrl: string = DATABASE_URL): Sql {
  return createDb(loadConfig({ DATABASE_URL: databaseUrl }));
}

export const silentLog: Log = { info: () => {}, warn: () => {} };

export type Tx = postgres.TransactionSql;

class Rollback extends Error {}

// Step 2: run a test inside a transaction that is always undone. Tests leave nothing behind and
// never see each other's rows, so the order they run in doesn't matter.
export async function inRollback(sql: Sql, body: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await body(tx);
      throw new Rollback(); // an error inside begin() = ROLLBACK
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

// Step 3: the database itself must refuse this query, with exactly this SQLSTATE.
// It runs in its own savepoint: after an error Postgres refuses everything else in the
// transaction (25P02) until it rolls back to a savepoint, so later queries still test something.
export async function expectRefused(tx: Tx, sqlstate: string, query: (sql: Tx) => Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await tx.savepoint(async (sp) => {
      await query(sp);
    });
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) {
    throw new Error(`expected the database to refuse it with ${sqlstate}, but it was accepted`);
  }
  const code = (caught as { code?: unknown } | null)?.code;
  if (code !== sqlstate) {
    throw new Error(`expected SQLSTATE ${sqlstate}, got ${String(code)}: ${(caught as Error).message}`);
  }
}
