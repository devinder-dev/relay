// Verifies signed demo requests and chooses failure/slow behavior from their trusted payload.
import { Webhook } from "standardwebhooks";

const MAX_TRACKED = 5_000; // Bound demo memory; clearing temporary counters is acceptable.

// Step 1: counters are demo state, reset on restart, never durable retry accounting.
export function createReceiver({ secret, port, maxTracked = MAX_TRACKED }: { secret: string; port: number; maxTracked?: number }) {
  const verifier = new Webhook(secret);
  const counts = new Map<string, number>();
  return Bun.serve({ port, hostname: "0.0.0.0", maxRequestBodySize: 64 * 1024,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return Response.json({ status: "ok" });
      if (request.method !== "POST" || url.pathname !== "/hooks") return new Response(null, { status: 404 });
      const id = request.headers.get("webhook-id") ?? "";
      let valid = false;
      let status = 401;
      try {
        // Step 2: enforce the byte limit before parsing or verifying the signed body.
        const reader = request.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 64 * 1024) { await reader.cancel(); status = 413; return new Response(null, { status }); }
            chunks.push(value);
          }
        }
        const verified = verifier.verify(Buffer.concat(chunks), Object.fromEntries(request.headers)) as {
          data?: { demo?: { fail?: unknown; slow_ms?: unknown } };
        };
        valid = true;
        const demo = verified?.data?.demo;
        if (!counts.has(id) && counts.size >= maxTracked) counts.clear();
        const tries = (counts.get(id) ?? 0) + 1; counts.set(id, tries);
        const fail = typeof demo?.fail === "number" && Number.isFinite(demo.fail) ? Math.max(0, Math.floor(demo.fail)) : 0;
        const slow = typeof demo?.slow_ms === "number" && Number.isFinite(demo.slow_ms)
          ? Math.min(15_000, Math.max(0, demo.slow_ms)) : 0;
        status = tries <= fail ? 500 : 200;
        if (slow) await Bun.sleep(slow);
        return new Response(null, { status });
      } catch (error) {
        status = (error as { code?: string }).code === "ERR_BODY_TOO_LARGE" ? 413 : 401;
        return new Response(null, { status });
      } finally {
        console.log(JSON.stringify({ level: "info", time: new Date().toISOString(), msg: valid ? "✅ demo request" : "⚠️ demo request refused",
          "webhook-id": id, signature_valid: valid, status }));
      }
    },
  });
}
// Step 3: imports in tests do not start a server; the production entry point requires its key.
if (import.meta.main) {
  const secret = process.env.DEMO_SIGNING_SECRET;
  if (!secret) throw new Error("DEMO_SIGNING_SECRET is required");
  createReceiver({ secret, port: 8080 });
}
