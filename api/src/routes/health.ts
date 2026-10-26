// Routes that Kubernetes and the pipeline call. No API key needed.
//   /health/live   "is the process alive?"  Never checks the database: a database outage
//                  must not make Kubernetes restart every pod.
//   /health/ready  "can I take traffic right now?"  Phase 2 adds the database check here.
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
