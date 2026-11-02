// Routes that Kubernetes and the pipeline call. No API key needed.
//   /health/live   "is the process alive?"  Never checks the database: a database outage
//                  must not make Kubernetes restart every pod.
//   /health/ready  "can I take traffic right now?"  Never checks the database either: one
//                  database blip would take every pod out of the Service at once. Instead the
//                  API waits for the database before it listens (server.ts), and a request
//                  that needs it during a blip gets our own 503 (error-handler.ts).
//                  While shutting down it answers 503 without any code here: after
//                  app.close() (server.ts), Fastify answers every new request with 503.
//   /version       which commit is running. The pipeline checks it after each deploy.
import type { FastifyPluginAsync } from "fastify";
import type { Config } from "../config.ts";

export const healthRoutes: FastifyPluginAsync<{ config: Config }> = async (app, { config }) => {
  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async () => ({ status: "ok" }));

  app.get("/version", async () => ({ sha: config.GIT_SHA }));
};
