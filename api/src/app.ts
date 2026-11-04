// Builds the Fastify app: settings, hooks and routes, wired together.
// It never listens on a port itself. server.ts does that, so tests can call
// buildApp() and send fake requests with app.inject().
import Fastify, { LogController, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { realLookup, type Lookup } from "./ssrf.ts";
import type { Sql } from "./db.ts";
import { v1Routes } from "./routes/v1.ts";
import type { Config } from "./config.ts";
import { errorHandler, notFoundHandler } from "./error-handler.ts";
import { healthRoutes } from "./routes/health.ts";

const DASHBOARD_ORIGINS = ["https://cdn.myrelay.tech", "http://localhost:4173"];

export function buildApp(
  config: Config,
  deps: { sql: Sql; lookup?: Lookup },
  options: { logger?: boolean; logStream?: { write(line: string): void } } = {},
): FastifyInstance {
  const app = Fastify({
    // JSON logs (pino). Tests pass logger: false to keep their output clean.
    logger: options.logger === false ? false : { level: config.LOG_LEVEL, stream: options.logStream },
    bodyLimit: 256 * 1024, // 256 KiB, bigger bodies get 413
    genReqId: () => crypto.randomUUID(), // a unique id for every request
    logController: new LogController({
      requestIdLogLabel: "request_id", // the name of that id in every log line
      // Kubernetes calls the health routes every few seconds on every pod.
      // Logging them would bury the lines that matter.
      disableRequestLogging: (request) => request.url.startsWith("/health/"),
    }),
  });

  // Step 1: accept JSON bodies and declare the per-request identity.
  app.removeContentTypeParser("text/plain");
  app.decorateRequest("owner", null);

  // Every response tells the client its request id: the same id as in our logs,
  // so "it failed" plus the id is enough to find the exact log lines.
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  // Set before the routes are registered, so every route uses them.
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  // Step 2: preflight runs at the root before the authenticated v1 routes.
  app.register(cors, {
    origin: DASHBOARD_ORIGINS,
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["authorization", "content-type", "idempotency-key"],
    exposedHeaders: ["x-request-id", "retry-after", "idempotent-replayed"],
    maxAge: 600,
    credentials: false,
    // Otherwise OPTIONS without preflight headers gets the plugin's plain-text 400.
    strictPreflight: false,
  });
  // Step 3: only the v1 plugin inherits the authentication hook.
  app.register(healthRoutes, { config });
  app.register(v1Routes, {
    prefix: "/v1", sql: deps.sql, lookup: deps.lookup ?? realLookup, allowOrigins: config.SSRF_ALLOW_ORIGINS,
  });

  return app;
}
