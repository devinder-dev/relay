// Starts the API: reads the config, builds the app, waits for the database, listens on a port,
// and stops cleanly when Kubernetes (or Ctrl+C) asks it to.
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createDb, waitForDatabase } from "./db.ts";

// Step 1: the config. A bad environment stops the app here, with a clear message.
const config = loadConfig();

// Step 2: the app and the database pool. The pool doesn't connect yet; the first query does.
const app = buildApp(config);
const sql = createDb(config);

// When Kubernetes sends SIGTERM or Ctrl+C sends SIGINT: stop taking requests and let running
// ones finish, then close the database connections (queries get 5 s), then exit.
// Set up BEFORE the wait below: in the container bun is process 1, and Linux ignores SIGTERM
// for process 1 unless it has a handler, so a pod stopped while still waiting would hang.
async function shutdown(signal: string) {
  app.log.info({ signal }, "shutting down");
  try {
    await app.close();
    await sql.end({ timeout: 5 });
    process.exit(0);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

// Step 3: wait for the database before opening the port. A pod that can't reach it never
// listens, so its startupProbe fails, the rollout fails, and relay-deploy rolls back.
try {
  await waitForDatabase(sql, app.log);
} catch (error) {
  app.log.fatal({ err: error }, "❌ database not reachable, stopping");
  await sql.end({ timeout: 1 });
  process.exit(1);
}

// Step 4: listen. 0.0.0.0 means "every network interface". Fastify's default (localhost)
// can't be reached from outside the container, so Kubernetes and Traefik would never reach us.
await app.listen({ port: config.PORT, host: "0.0.0.0" });
