// Starts the API: reads the config, builds the app, listens on a port,
// and stops cleanly when Kubernetes (or Ctrl+C) asks it to.
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig(); // a bad environment stops the app here, with a clear message
const app = buildApp(config);

// 0.0.0.0 means "every network interface". Fastify's default (localhost) can't be
// reached from outside the container, so Kubernetes and Traefik would never reach us.
await app.listen({ port: config.PORT, host: "0.0.0.0" });

// When Kubernetes sends SIGTERM or Ctrl+C sends SIGINT, we stop the server
async function shutdown(signal: string) {
  app.log.info({ signal }, "shutting down");
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
