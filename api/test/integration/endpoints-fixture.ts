// Gives each endpoint test file its own owners, app and cleanup without sharing customer rows.
import { afterAll, beforeAll } from "bun:test";
import { buildApp } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import { createOwnerWithKey } from "../../src/services/owners.ts";
import type { Lookup } from "../../src/ssrf.ts";
import { DATABASE_URL, testDb } from "./helpers.ts";

// Step 1: fixture ownership stays inside the calling test file.
export function endpointFixture() {
  const sql = testDb();
  const owners: Awaited<ReturnType<typeof createOwnerWithKey>>[] = [];
  const lines: string[] = [];
  let lookup: Lookup = async () => ["93.184.215.14"];
  const app = buildApp(loadConfig({ DATABASE_URL }), { sql, lookup: (host) => lookup(host) }, {
    logStream: { write: (line) => { lines.push(line); } },
  });
  async function owner() {
    const created = await createOwnerWithKey(sql, `endpoints-${crypto.randomUUID()}`);
    owners.push(created);
    return created;
  }
  beforeAll(async () => { await app.ready(); });
  afterAll(async () => {
    try {
      await app.close();
      for (const created of owners) await sql`DELETE FROM owners WHERE id = ${created.owner.id}`;
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
  // Step 2: requests exercise the real authentication and error handler.
  function post(key: string, input: object = {}) {
    return app.inject({ method: "POST", url: "/v1/endpoints", headers: { authorization: `Bearer ${key}` },
      payload: { name: "Webhook", url: "https://example.com/hook", ...input } });
  }
  function list(key: string) {
    return app.inject({ url: "/v1/endpoints", headers: { authorization: `Bearer ${key}` } });
  }
  return { sql, app, owner, post, list, lines, setLookup: (next: Lookup) => { lookup = next; } };
}
