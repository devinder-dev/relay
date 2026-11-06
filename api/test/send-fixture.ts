// Runs local HTTP fixtures and closes every socket after the calling test file.
import { afterAll } from "bun:test";
import http, { type RequestListener, type Server } from "node:http";
import https from "node:https";
import { sendWebhook, type SendOptions } from "../src/worker/send.ts";

export function sendFixture() {
  const servers: Server[] = [];
  afterAll(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  // Step 1: the fake hostname forces resolution; only the checked loopback is connected.
  async function start(handler: RequestListener, tls?: { key: Buffer; cert: Buffer }) {
    const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    const origin = `${tls ? "https" : "http"}://receiver.test:${address.port}`;
    const options: SendOptions = { lookup: async () => ["127.0.0.1"], allowOrigins: [origin], deadlineMs: 150 };
    const send = (overrides: Partial<SendOptions> = {}, path = "/hooks?q=1") => sendWebhook({
      url: origin + path, body: Buffer.from('{"hello":"😀"}'), headers: { "webhook-id": "test-event" },
    }, { ...options, ...overrides });
    return { server, origin, send, options };
  }
  return { start };
}
