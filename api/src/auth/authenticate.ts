// Finds the owner of a single active API key before a protected route runs.
import type { onRequestAsyncHookHandler } from "fastify";
import type { Sql } from "../db.ts";
import { unauthorized } from "../errors.ts";
import { findOwnerByKeyHash } from "../repositories/owners.ts";
import { hashApiKey, parseBearerKey } from "./api-key.ts";

declare module "fastify" {
  interface FastifyRequest {
    owner: { id: string; name: string; keyPrefix: string } | null;
  }
}

// Step 1: reject duplicate headers before Bun can hide the second value.
export function authenticate(sql: Sql): onRequestAsyncHookHandler {
  return async (request) => {
    let count = 0;
    for (let i = 0; i < request.raw.rawHeaders.length; i += 2) {
      if (request.raw.rawHeaders[i]?.toLowerCase() === "authorization") count++;
    }
    if (count > 1) throw unauthorized();
    const key = parseBearerKey(request.headers.authorization);
    if (key === null) throw unauthorized();

    // Step 2: database failures propagate to the shared error handler.
    const owner = await findOwnerByKeyHash(sql, hashApiKey(key));
    if (owner === null) throw unauthorized();
    request.owner = { id: owner.ownerId, name: owner.ownerName, keyPrefix: owner.keyPrefix };
  };
}
