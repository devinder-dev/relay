// Builds webhook bytes once and signs those exact bytes using Standard Webhooks.
import { createHmac } from "node:crypto";

// Step 1: event time belongs to the immutable body; send time belongs to the headers.
export function buildBody(input: { type: string; createdAt: Date; payload: Record<string, unknown> }): Buffer {
  return Buffer.from(JSON.stringify({ type: input.type, timestamp: input.createdAt.toISOString(), data: input.payload }));
}
export function signatureHeaders(input: { secret: string; eventId: string; body: Buffer; nowSeconds: number }): Record<string, string> {
  const timestamp = String(Math.floor(input.nowSeconds));
  const key = Buffer.from(input.secret.replace(/^whsec_/, ""), "base64");
  const signature = createHmac("sha256", key).update(`${input.eventId}.${timestamp}.`).update(input.body).digest("base64");
  return { "webhook-id": input.eventId, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` };
}
