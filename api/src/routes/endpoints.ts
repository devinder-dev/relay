// Creates and lists endpoints, exposing a signing secret only in the create response.
import type { FastifyPluginAsync } from "fastify";
import type { Sql } from "../db.ts";
import { unauthorized } from "../errors.ts";
import { EndpointCreate } from "../schemas/endpoints.ts";
import { createEndpoint, listEndpoints } from "../services/endpoints.ts";
import type { Lookup } from "../ssrf.ts";

type Options = { sql: Sql; lookup: Lookup; allowOrigins: string[] };
export const endpointRoutes: FastifyPluginAsync<Options> = async (app, options) => {
  // Step 1: validation throws to the shared error handler; successful creates return 201.
  app.post("/endpoints", async (request, reply) => {
    if (!request.owner) throw unauthorized();
    const input = EndpointCreate.parse(request.body);
    const { endpoint: e, signingSecret } = await createEndpoint(options.sql, request.owner.id, input, options);
    return reply.code(201).send({
      id: e.id, name: e.name, url: e.url, event_types: e.event_types,
      status: "active", created_at: e.created_at.toISOString(), signing_secret: signingSecret,
    });
  });
  // Step 2: build every public field explicitly; the secret never enters a list response.
  app.get("/endpoints", async (request) => {
    if (!request.owner) throw unauthorized();
    const endpoints = await listEndpoints(options.sql, request.owner.id);
    return { data: endpoints.map((e) => ({
      id: e.id, name: e.name, url: e.url, event_types: e.event_types,
      status: e.status, created_at: e.created_at.toISOString(),
    })) };
  });
};
