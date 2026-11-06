// Verifies our wire bytes against the independent Standard Webhooks verifier.
import { expect, test } from "bun:test";
import { Webhook } from "standardwebhooks";
import { buildBody, signatureHeaders } from "./sign.ts";

const secret = "whsec_" + Buffer.alloc(32, 7).toString("base64");
// Step 1: Unicode body bytes and send timestamps must survive independent verification.
test("exact body verifies; a changed byte and a six-minute-old send fail", () => {
  const body = buildBody({ type: "invoice.paid", createdAt: new Date("2026-01-01T00:00:00Z"), payload: { value: "😀" } });
  expect(JSON.parse(body.toString())).toEqual({ type: "invoice.paid", timestamp: "2026-01-01T00:00:00.000Z", data: { value: "😀" } });
  const nowSeconds = Math.floor(Date.now() / 1000);
  const headers = signatureHeaders({ secret, eventId: "event-1", body, nowSeconds });
  expect(headers["webhook-id"]).toBe("event-1");
  expect(headers["webhook-timestamp"]).toBe(String(nowSeconds));
  expect(new Webhook(secret).verify(body, headers)).toEqual(JSON.parse(body.toString()));
  expect(() => new Webhook(secret).verify(Buffer.concat([body, Buffer.from(" ")]), headers)).toThrow();
  const stale = signatureHeaders({ secret, eventId: "event-1", body, nowSeconds: nowSeconds - 360 });
  expect(() => new Webhook(secret).verify(body, stale)).toThrow();
});
