// Keeps authentication inside the v1 route scope, leaving health routes open.
import type { FastifyPluginAsync } from "fastify";
import { authenticate } from "../auth/authenticate.ts";
import type { Sql } from "../db.ts";
import { meRoutes } from "./me.ts";

// Step 1: child routes inherit this hook through Fastify encapsulation.
export const v1Routes: FastifyPluginAsync<{ sql: Sql }> = async (app, { sql }) => {
  app.addHook("onRequest", authenticate(sql));
  app.register(meRoutes);
};
