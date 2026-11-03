// Checks endpoint destinations before saving them and coordinates owner-scoped endpoint rules.
import { randomBytes } from "node:crypto";
import type { Sql } from "../db.ts";
import { endpointLimitReached } from "../errors.ts";
import { countLiveEndpoints, insertEndpoint, listLiveEndpoints, lockOwner } from "../repositories/endpoints.ts";
import type { EndpointInput } from "../schemas/endpoints.ts";
import { checkEndpointUrl, type Lookup } from "../ssrf.ts";

export const MAX_ENDPOINTS = 20;
export function generateSigningSecret(): string {
  return "whsec_" + randomBytes(32).toString("base64");
}

export async function createEndpoint(
  sql: Sql, ownerId: string, input: EndpointInput, options: { lookup: Lookup; allowOrigins: string[] },
) {
  // Step 1: DNS can take seconds; no lock or connection is held while waiting on the network.
  await checkEndpointUrl(input.url, options);
  // Step 2: generate the secret, shown only in the create response.
  const secret = generateSigningSecret();
  // Step 3: the owner limit and insert belong in the same transaction.
  return sql.begin(async (tx) => {
    // Step 4: lock the owner's row first, so two creates of the same owner take turns.
    await lockOwner(tx, ownerId);
    // Step 5: count only after the lock, in its own statement, so it sees the other create's row.
    if ((await countLiveEndpoints(tx, ownerId)) >= MAX_ENDPOINTS) throw endpointLimitReached();
    const endpoint = await insertEndpoint(tx, ownerId, input, secret);
    return { endpoint, signingSecret: secret };
  });
}

export async function listEndpoints(sql: Sql, ownerId: string) {
  return listLiveEndpoints(sql, ownerId);
}
