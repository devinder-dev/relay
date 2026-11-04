// Creates an owner and its first API key as one indivisible database transaction.
import { generateApiKey } from "../auth/api-key.ts";
import type { Sql } from "../db.ts";
import { insertApiKey, insertOwner } from "../repositories/owners.ts";

// Step 1: either both inserts succeed, or Postgres rolls both back.
export async function createOwnerWithKey(sql: Sql, name: string) {
  const { key, prefix, hash } = generateApiKey();
  return sql.begin(async (tx) => {
    const owner = await insertOwner(tx, name);
    await insertApiKey(tx, { ownerId: owner.id, prefix, keyHash: hash });
    return { owner, key, prefix };
  });
}
