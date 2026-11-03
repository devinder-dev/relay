// Returns only the authenticated owner's identity and the safe key prefix.
import type { FastifyPluginAsync } from "fastify";
import { unauthorized } from "../errors.ts";

// Step 1: build the response field by field so the secret key cannot be included.
export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get("/me", async (request) => {
    const owner = request.owner;
    if (owner === null) throw unauthorized();
    return { owner: { id: owner.id, name: owner.name }, key: { prefix: owner.keyPrefix } };
  });
};
