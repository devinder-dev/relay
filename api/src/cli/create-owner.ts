// Creates an owner and prints its API key once, without using a logger.
// Usage: bun src/cli/create-owner.ts --name "Acme"
// Production: kubectl -n relay exec deploy/relay-api -- bun src/cli/create-owner.ts --name "Acme"
import { loadConfig } from "../config.ts";
import { createDb, type Sql } from "../db.ts";
import { OwnerName } from "../schemas/owners.ts";
import { createOwnerWithKey } from "../services/owners.ts";

// Step 1: validate arguments before making a pool or writing anything.
let sql: Sql | undefined;
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--name") throw new Error("Usage: --name <owner name>");
  const parsed = OwnerName.safeParse(args[1]);
  if (!parsed.success) throw new Error("Name must be 1–100 characters without control characters");
  sql = createDb(loadConfig());
  const { owner, key } = await createOwnerWithKey(sql, parsed.data);

  // Step 2: stdout is the only place the full key is ever printed.
  console.log(`✅ Owner created: ${owner.name} (${owner.id})`);
  console.log(`API key (shown once, store it now in a password manager): ${key}`);
} catch (error) {
  // Never print database errors: detail and where may contain secret row values.
  const reason = sql ? "Could not create owner" : error instanceof Error ? error.message : "Could not create owner";
  console.error(`❌ ${reason}`);
  process.exitCode = 1;
} finally {
  // Step 3: close even after a failed insert, without leaking close-error details.
  try {
    await sql?.end({ timeout: 5 });
  } catch {
    console.error("❌ Could not close database connections");
    process.exitCode = 1;
  }
}
