// Runs the owner CLI as a child process and removes only owners this file created.
import { afterAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { hashApiKey } from "../../src/auth/api-key.ts";
import { DATABASE_URL, testDb } from "./helpers.ts";

// Step 1: use the same runtime and test database, never a production configuration.
const sql = testDb();
const names: string[] = [];
const ids: string[] = [];
async function run(name: string) {
  const child = Bun.spawn([process.execPath, "src/cli/create-owner.ts", "--name", name], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: { ...process.env, DATABASE_URL }, stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
afterAll(async () => {
  try {
    // Recover the id by the unique name too, so a failed output assertion leaves no fixture.
    for (const name of names) {
      const rows = await sql`SELECT id FROM owners WHERE name = ${name}`;
      for (const row of rows) ids.push(row.id);
    }
    if (ids.length) await sql`DELETE FROM owners WHERE id IN ${sql(ids)}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
});

// Step 2: the printed key is usable through its hash, independently of the header TODO.
test("CLI creates one owner and prints exactly one key", async () => {
  const name = `cli-${crypto.randomUUID()}`;
  names.push(name);
  const result = await run(name);
  const [owner] = await sql`SELECT id, name FROM owners WHERE name = ${name}`;
  if (owner) ids.push(owner.id);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const keys = result.stdout.match(/relay_live_[A-Za-z0-9_-]{43}/g) ?? [];
  expect(keys.length).toBe(1);
  const key = keys[0];
  if (!key) throw new Error("CLI did not print a key");
  expect(result.stdout.trim().split("\n")).toEqual([
    `✅ Owner created: ${name} (${owner?.id})`,
    `API key (shown once, store it now in a password manager): ${key}`,
  ]);
  const [saved] = await sql`SELECT owner_id FROM api_keys WHERE key_hash = ${hashApiKey(key)}`;
  expect(saved?.owner_id).toBe(owner?.id);
});

// Step 3: NUL is covered by the schema unit test: OS arguments cannot carry it.
for (const name of ["", `invalid-${crypto.randomUUID()}\n`]) {
  test(`CLI rejects ${name === "" ? "an empty name" : "a control character"} without creating an owner`, async () => {
    names.push(name);
    const result = await run(name);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("❌");
    const rows = await sql`SELECT id FROM owners WHERE name = ${name}`;
    expect(rows.length).toBe(0);
  });
}
