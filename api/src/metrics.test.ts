import { expect, test } from "bun:test";
import { Metrics, startMetricsServer } from "./metrics.ts";

test("metrics use bounded labels and Prometheus cumulative histogram buckets", () => {
  const metrics = new Metrics();
  metrics.observeHttp("POST", "/v1/deliveries/:id/replay", 202, 0.2);
  metrics.observeDelivery("delivered", 0.3);
  metrics.recordWorkerLoopError();
  const rendered = metrics.render();
  expect(rendered).toContain('relay_http_requests_total{method="POST",route="/v1/deliveries/:id/replay",status_code="202"} 1');
  expect(rendered).toContain('relay_http_request_duration_seconds_bucket{method="POST",route="/v1/deliveries/:id/replay",status_code="202",le="0.25"} 1');
  expect(rendered).toContain('relay_worker_delivery_attempts_total{outcome="delivered"} 1');
  expect(rendered).toContain("relay_worker_loop_errors_total 1");
});

test("metrics endpoint serves only Prometheus text", async () => {
  const metrics = new Metrics();
  metrics.observeHttp("GET", "/v1/me", 200, 0.01);
  const server = startMetricsServer(0, metrics);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const response = await fetch(`${base}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain; version=0.0.4");
    expect(await response.text()).toContain("relay_http_requests_total");
    expect((await fetch(`${base}/other`)).status).toBe(404);
  } finally {
    server.stop(true);
  }
});
