// Builds the Fastify app: settings, hooks and routes, wired together.
// It never listens on a port itself. server.ts does that, so tests can call
// buildApp() and send fake requests with app.inject().
import Fastify, { LogController, type FastifyInstance } from "fastify";
import type { Config } from "./config.ts";
import { errorHandler, notFoundHandler } from "./error-handler.ts";
import { healthRoutes } from "./routes/health.ts";

export function buildApp(config: Config, options: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({
    // JSON logs (pino). Tests pass logger: false to keep their output clean.
    logger: options.logger === false ? false : { level: config.LOG_LEVEL },
    bodyLimit: 256 * 1024, // 256 KiB, bigger bodies get 413
    genReqId: () => crypto.randomUUID(), // a unique id for every request
    logController: new LogController({
      requestIdLogLabel: "request_id", // the name of that id in every log line
      // Kubernetes calls the health routes every few seconds on every pod.
      // Logging them would bury the lines that matter.
      disableRequestLogging: (request) => request.url.startsWith("/health/"),
    }),
  });

  // Every response tells the client its request id: the same id as in our logs,
  // so "it failed" plus the id is enough to find the exact log lines.
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  // Set before the routes are registered, so every route uses them.
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  app.register(healthRoutes, { config });

  return app;
}
