// Sends only to a checked, pinned destination with a deadline and bounded response excerpt.
import http, { type ClientRequest } from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { resolveTarget, type Lookup } from "../ssrf.ts";
import { DNS_TIMEOUT_MS, EXCERPT_BYTES, SEND_DEADLINE_MS } from "./config.ts";

export type AttemptError = "timeout" | "connect_failed" | "blocked_address" | "redirect" | "tls";
export type SendResult = {
  startedAt: Date; durationMs: number; statusCode: number | null; error: AttemptError | null; excerpt: string | null;
};
export type Clock = { now(): Date; monotonic(): number };
export const systemClock: Clock = { now: () => new Date(), monotonic: () => performance.now() };
export type SendOptions = {
  lookup: Lookup; allowOrigins: string[]; deadlineMs?: number; dnsTimeoutMs?: number;
  ca?: string | Buffer; clock?: Clock; logCode?: (code: string) => void;
};
export type WebhookInput = { url: string; body: Buffer; headers: Record<string, string> };
const TLS_CODES = new Set(["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"]);
const CONNECTION_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "ENOTFOUND"]);

// Step 1: pin both callback forms; Node may request an array for address-family selection.
function pin(address: string): LookupFunction {
  return (_host, options, callback) => {
    const family = isIP(address);
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}
export function sendWebhook(input: WebhookInput, options: SendOptions): Promise<SendResult> {
  const clock = options.clock ?? systemClock;
  const startedAt = clock.now(), start = clock.monotonic();
  const deadlineMs = options.deadlineMs ?? SEND_DEADLINE_MS;
  return new Promise((resolve) => {
    let request: ClientRequest | undefined;
    let settled = false, receivedHeaders = false, size = 0;
    let statusCode: number | null = null, error: AttemptError | null = null;
    const chunks: Buffer[] = [];
    // Step 2: headers decide the outcome; cleanup and body errors cannot overwrite it.
    const finish = (failure?: AttemptError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!receivedHeaders) error = failure ?? "connect_failed";
      request?.destroy();
      resolve({ startedAt, durationMs: Math.max(0, Math.round(clock.monotonic() - start)), statusCode, error,
        excerpt: receivedHeaders ? Buffer.concat(chunks, size).toString("utf8").replace(/\u0000/g, "") : null });
    };
    const timer = setTimeout(() => finish("timeout"), deadlineMs);
    const connect = async () => {
      const target = await resolveTarget(input.url, { lookup: options.lookup, allowOrigins: options.allowOrigins,
        timeoutMs: Math.min(options.dnsTimeoutMs ?? DNS_TIMEOUT_MS, Math.max(0, deadlineMs - (clock.monotonic() - start))) });
      if (settled) return;
      if (!target.ok) {
        finish(target.reason === "timeout" ? "timeout" : target.reason === "dns_failed" ? "connect_failed" : "blocked_address");
        return;
      }
      if (clock.monotonic() - start >= deadlineMs) { finish("timeout"); return; }
      const { url } = target;
      const transport = url.protocol === "http:" && target.allowListed ? http : https;
      // Step 3: preserve the URL host for Host/SNI; only the lookup callback supplies the address.
      request = transport.request({ host: url.hostname.replace(/^\[|\]$/g, ""), port: url.port || undefined,
        path: url.pathname + url.search, method: "POST", agent: false, lookup: pin(target.addresses[0]!), ca: options.ca,
        headers: { ...input.headers, "content-type": "application/json", "user-agent": "Relay/1 (+https://api.myrelay.tech)",
          "content-length": input.body.byteLength } }, (response) => {
        receivedHeaders = true;
        statusCode = response.statusCode ?? null;
        error = statusCode !== null && statusCode >= 300 && statusCode < 400 ? "redirect" : null;
        response.on("data", (chunk: Buffer) => {
          if (settled) return;
          const kept = Buffer.from(chunk).subarray(0, EXCERPT_BYTES - size);
          chunks.push(kept); size += kept.length;
          if (size === EXCERPT_BYTES) finish();
        });
        response.on("end", () => finish());
        response.on("error", () => finish());
        response.on("close", () => finish());
      });
      request.on("error", (caught: NodeJS.ErrnoException) => {
        if (settled) return;
        const code = caught.code ?? "UNKNOWN";
        const tls = code.startsWith("ERR_TLS_") || code.startsWith("CERT_") || TLS_CODES.has(code);
        if (!tls && !CONNECTION_CODES.has(code)) {
          (options.logCode ?? ((value) => console.warn(JSON.stringify({ level: "warn", msg: "⚠️ unclassified send error", code: value }))))(code);
        }
        finish(tls ? "tls" : "connect_failed");
      });
      request.end(input.body);
    };
    void connect().catch(() => finish("connect_failed"));
  });
}
