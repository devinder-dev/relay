// Accepts validated event requests and marks answers returned from a retry key.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Sql } from "../db.ts";
import { unauthorized } from "../errors.ts";
import { EventCreate, IdempotencyKey } from "../schemas/events.ts";
import { createEvent } from "../services/events.ts";

// Step 1: parse the header in an object so validation names its exact public path.
const Headers = z.object({ "idempotency-key": IdempotencyKey });
export const eventRoutes: FastifyPluginAsync<{ sql: Sql }> = async (app, { sql }) => {
  app.post("/events", async (request, reply) => {
    if (!request.owner) throw unauthorized();
    const input = EventCreate.parse(request.body);
    const headers = Headers.parse({ "idempotency-key": request.headers["idempotency-key"] });
    const { event, deliveries, replayed } = await createEvent(sql, request.owner.id, input, headers["idempotency-key"]);
    if (replayed) reply.header("idempotent-replayed", "true");
    return reply.code(202).send({ id: event.id, type: event.type, created_at: event.created_at.toISOString(), deliveries });
  });
};
