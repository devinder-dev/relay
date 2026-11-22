// Reports loop progress, without turning a database outage into a restart storm.
import { HEARTBEAT_STALE_MS } from "./config.ts";
import type { Metrics } from "../metrics.ts";

// Step 1: monotonic elapsed time is unaffected by wall-clock corrections.
export function startHealth(port: number, heartbeat: { last: number }, now = () => performance.now(), metrics?: Metrics) {
  return Bun.serve({ port, hostname: "0.0.0.0", fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/metrics" && metrics) {
      return new Response(metrics.render(), { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" } });
    }
    if (request.method !== "GET" || path !== "/health/live") {
      return new Response(null, { status: 404 });
    }
    const healthy = now() - heartbeat.last < HEARTBEAT_STALE_MS;
    return Response.json({ status: healthy ? "ok" : "stalled" }, { status: healthy ? 200 : 503 });
  } });
}
