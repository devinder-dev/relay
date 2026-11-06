// Checks independent signature verification, trusted demo behavior and the receiver body limit.
import { afterAll, expect, spyOn, test } from "bun:test";
import { createReceiver } from "../../src/demo/receiver.ts";
import { buildBody, signatureHeaders } from "../../src/worker/sign.ts";

const secret = "whsec_" + Buffer.alloc(32, 4).toString("base64");
const receiver = createReceiver({ secret, port: 0 });
afterAll(() => receiver.stop(true));
function request(payload = {}, id = crypto.randomUUID(), tamper = false) {
  const body = buildBody({ type: "demo.ping", createdAt: new Date(), payload });
  const headers = signatureHeaders({ secret, eventId: id, body, nowSeconds: Date.now() / 1000 });
  return fetch(`http://127.0.0.1:${receiver.port}/hooks`, { method: "POST", headers,
    body: tamper ? Buffer.concat([body, Buffer.from(" ")]) : body });
}
// Step 1: only the verified payload controls behavior; URL parameters have no role.
test("valid and tampered bodies, missing headers and repeated failures", async () => {
  expect((await request()).status).toBe(200);
  expect((await request({}, undefined, true)).status).toBe(401);
  expect((await fetch(`http://127.0.0.1:${receiver.port}/hooks`, { method: "POST", body: "{}" })).status).toBe(401);
  const id = crypto.randomUUID();
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await request({ demo: { fail: 2 } }, id)).status);
  expect(statuses).toEqual([500, 500, 200]);
});
test("oversized bodies are refused before verification, including streamed bodies", async () => {
  const url = `http://127.0.0.1:${receiver.port}/hooks`;
  expect((await fetch(url, { method: "POST", body: "x".repeat(65 * 1024) })).status).toBe(413);
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(40 * 1024)); controller.enqueue(new Uint8Array(40 * 1024)); controller.close();
  } });
  expect((await fetch(url, { method: "POST", body: stream })).status).toBe(413);
});
test("slow_ms is capped at fifteen seconds", async () => {
  const sleep = spyOn(Bun, "sleep").mockImplementation(() => Promise.resolve());
  try { expect((await request({ demo: { slow_ms: 999999 } })).status).toBe(200); expect(sleep).toHaveBeenCalledWith(15_000); }
  finally { sleep.mockRestore(); }
});
