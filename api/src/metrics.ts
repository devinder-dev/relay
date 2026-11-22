// Small, dependency-free Prometheus exposition for Relay's bounded metric set.
// Do not add request ids, endpoint ids, URLs, API keys, or payload fields as labels: every
// distinct value becomes a time series and can exhaust this VPS's Prometheus memory.
const HTTP_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const DELIVERY_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10];

type Histogram = { buckets: number[]; counts: number[]; count: number; sum: number };

function escapeLabel(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function labels(values: Record<string, string>) {
  return `{${Object.entries(values).map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}`;
}

function newHistogram(buckets: number[]): Histogram {
  return { buckets, counts: buckets.map(() => 0), count: 0, sum: 0 };
}

function observe(histogram: Histogram, value: number) {
  histogram.count += 1;
  histogram.sum += value;
  for (const [index, bucket] of histogram.buckets.entries()) {
    if (value <= bucket) histogram.counts[index]! += 1;
  }
}

export class Metrics {
  private readonly httpRequests = new Map<string, number>();
  private readonly httpDurations = new Map<string, Histogram>();
  private readonly deliveryAttempts = new Map<string, number>();
  private readonly deliveryDurations = new Map<string, Histogram>();
  private workerLoopErrors = 0;
  private databaseQuerySuccess: number | undefined;
  private databaseQueryChecks = new Map<"success" | "error", number>();

  observeHttp(method: string, route: string, statusCode: number, durationSeconds: number) {
    const values = { method, route, status_code: String(statusCode) };
    const key = JSON.stringify(values);
    this.httpRequests.set(key, (this.httpRequests.get(key) ?? 0) + 1);
    const histogram = this.httpDurations.get(key) ?? newHistogram(HTTP_BUCKETS);
    observe(histogram, durationSeconds);
    this.httpDurations.set(key, histogram);
  }

  observeDelivery(outcome: "delivered" | "retry" | "dead" | "deleted", durationSeconds?: number) {
    this.deliveryAttempts.set(outcome, (this.deliveryAttempts.get(outcome) ?? 0) + 1);
    if (durationSeconds === undefined) return;
    const histogram = this.deliveryDurations.get(outcome) ?? newHistogram(DELIVERY_BUCKETS);
    observe(histogram, durationSeconds);
    this.deliveryDurations.set(outcome, histogram);
  }

  recordWorkerLoopError() {
    this.workerLoopErrors += 1;
  }

  recordDatabaseQuery(success: boolean) {
    this.databaseQuerySuccess = success ? 1 : 0;
    const outcome = success ? "success" : "error";
    this.databaseQueryChecks.set(outcome, (this.databaseQueryChecks.get(outcome) ?? 0) + 1);
  }

  render() {
    const lines = [
      "# HELP relay_http_requests_total HTTP responses produced by Relay, excluding health checks.",
      "# TYPE relay_http_requests_total counter",
    ];
    for (const [key, value] of this.httpRequests) lines.push(`relay_http_requests_total${labels(JSON.parse(key))} ${value}`);
    lines.push("# HELP relay_http_request_duration_seconds HTTP request duration in seconds.", "# TYPE relay_http_request_duration_seconds histogram");
    this.renderHistograms(lines, "relay_http_request_duration_seconds", this.httpDurations, JSON.parse);
    lines.push("# HELP relay_worker_delivery_attempts_total Delivery attempts finalized by the worker.", "# TYPE relay_worker_delivery_attempts_total counter");
    for (const [outcome, value] of this.deliveryAttempts) lines.push(`relay_worker_delivery_attempts_total${labels({ outcome })} ${value}`);
    lines.push("# HELP relay_worker_delivery_duration_seconds Webhook attempt duration in seconds.", "# TYPE relay_worker_delivery_duration_seconds histogram");
    this.renderHistograms(lines, "relay_worker_delivery_duration_seconds", this.deliveryDurations, (outcome) => ({ outcome }));
    lines.push("# HELP relay_worker_loop_errors_total Worker loop errors, normally database or finalization failures.", "# TYPE relay_worker_loop_errors_total counter", `relay_worker_loop_errors_total ${this.workerLoopErrors}`);
    lines.push("# HELP relay_database_query_success Last periodic database query result; 1 is success and 0 is failure.", "# TYPE relay_database_query_success gauge");
    if (this.databaseQuerySuccess !== undefined) lines.push(`relay_database_query_success ${this.databaseQuerySuccess}`);
    lines.push("# HELP relay_database_query_checks_total Periodic database query checks by outcome.", "# TYPE relay_database_query_checks_total counter");
    for (const [outcome, value] of this.databaseQueryChecks) lines.push(`relay_database_query_checks_total${labels({ outcome })} ${value}`);
    return `${lines.join("\n")}\n`;
  }

  private renderHistograms(
    lines: string[], name: string, histograms: Map<string, Histogram>, toLabels: (key: string) => Record<string, string>,
  ) {
    for (const [key, histogram] of histograms) {
      const base = toLabels(key);
      for (const [index, bucket] of histogram.buckets.entries()) {
        lines.push(`${name}_bucket${labels({ ...base, le: String(bucket) })} ${histogram.counts[index]}`);
      }
      lines.push(`${name}_bucket${labels({ ...base, le: "+Inf" })} ${histogram.count}`);
      lines.push(`${name}_sum${labels(base)} ${histogram.sum}`);
      lines.push(`${name}_count${labels(base)} ${histogram.count}`);
    }
  }
}

export function startMetricsServer(port: number, metrics: Metrics) {
  return Bun.serve({ port, hostname: "0.0.0.0", fetch(request) {
    if (request.method !== "GET" || new URL(request.url).pathname !== "/metrics") return new Response(null, { status: 404 });
    return new Response(metrics.render(), { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" } });
  } });
}
