// Reads and writes owners and their hashed API keys using parameterized SQL.
import type postgres from "postgres";
import type { Sql } from "../db.ts";

type Db = Sql | postgres.TransactionSql;
type Owner = { id: string; name: string };
type KeyOwner = { ownerId: string; ownerName: string; keyPrefix: string };

// Step 1: writes accept a transaction handle so owner and key are saved together.
export async function insertOwner(db: Db, name: string): Promise<Owner> {
  const [owner] = await db<Owner[]>`INSERT INTO owners (name) VALUES (${name}) RETURNING id, name`;
  if (!owner) throw new Error("Owner insert returned no row");
  return owner;
}

export async function insertApiKey(db: Db, key: { ownerId: string; prefix: string; keyHash: Buffer }): Promise<void> {
  await db`INSERT INTO api_keys (owner_id, prefix, key_hash)
    VALUES (${key.ownerId}, ${key.prefix}, ${key.keyHash})`;
}

// Step 2: this lookup has no owner filter: it discovers the owner from an active key.
export async function findOwnerByKeyHash(db: Db, keyHash: Buffer): Promise<KeyOwner | null> {
  const [owner] = await db<KeyOwner[]>`
    SELECT owners.id AS "ownerId", owners.name AS "ownerName", api_keys.prefix AS "keyPrefix"
    FROM api_keys JOIN owners ON owners.id = api_keys.owner_id
    WHERE api_keys.key_hash = ${keyHash} AND api_keys.revoked_at IS NULL`;
  return owner ?? null;
}
