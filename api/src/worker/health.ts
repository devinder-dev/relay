// Reports loop progress, without turning a database outage into a restart storm.
import { HEARTBEAT_STALE_MS } from "./config.ts";

// Step 1: monotonic elapsed time is unaffected by wall-clock corrections.
export function startHealth(port: number, heartbeat: { last: number }, now = () => performance.now()) {
  return Bun.serve({ port, hostname: "0.0.0.0", fetch(request) {
    if (request.method !== "GET" || new URL(request.url).pathname !== "/health/live") {
      return new Response(null, { status: 404 });
    }
    const healthy = now() - heartbeat.last < HEARTBEAT_STALE_MS;
    return Response.json({ status: healthy ? "ok" : "stalled" }, { status: healthy ? 200 : 503 });
  } });
}
