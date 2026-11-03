// Keeps authentication inside the v1 route scope, leaving health routes open.
import type { FastifyPluginAsync } from "fastify";
import { authenticate } from "../auth/authenticate.ts";
import type { Sql } from "../db.ts";
import type { Lookup } from "../ssrf.ts";
import { endpointRoutes } from "./endpoints.ts";
import { meRoutes } from "./me.ts";
import { eventRoutes } from "./events.ts";
import { deliveryRoutes } from "./deliveries.ts";

// Step 1: child routes inherit this hook through Fastify encapsulation.
export const v1Routes: FastifyPluginAsync<{ sql: Sql; lookup: Lookup; allowOrigins: string[] }> = async (app, { sql, lookup, allowOrigins }) => {
  app.addHook("onRequest", authenticate(sql));
  app.register(meRoutes);
  app.register(endpointRoutes, { sql, lookup, allowOrigins });
  app.register(eventRoutes, { sql });
  app.register(deliveryRoutes, { sql });
};
