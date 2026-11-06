// Checks typed resolution results while creation retains its approved-origin shortcut.
import { expect, test } from "bun:test";
import { resolveTarget } from "./ssrf.ts";

const base = { allowOrigins: [], lookup: async () => ["8.8.8.8"] };
// Step 1: each refusal retains enough meaning for the sender to classify it safely.
for (const [url, reason] of [["bad", "invalid_url"], ["https://u:p@example.com", "userinfo"],
  ["http://example.com", "not_https"], ["https://example.com:444", "port"],
  ["https://x.internal", "local_name"], ["https://127.0.0.1", "private"]] as const) {
  test(`reason ${reason}`, async () => expect(await resolveTarget(url!, base)).toEqual({ ok: false, reason }));
}
test("approved origins still resolve for sending; empty, failed and slow DNS are typed", async () => {
  let calls = 0;
  const result = await resolveTarget("http://receiver.internal/hook", {
    allowOrigins: ["http://receiver.internal"], lookup: async () => { calls++; return ["127.0.0.1"]; },
  });
  expect(result.ok && result.addresses).toEqual(["127.0.0.1"]);
  expect(calls).toBe(1);
  expect(await resolveTarget("https://example.com", { ...base, lookup: async () => [] }))
    .toEqual({ ok: false, reason: "dns_failed" });
  expect(await resolveTarget("https://example.com", { ...base, lookup: async () => { throw new Error(); } }))
    .toEqual({ ok: false, reason: "dns_failed" });
  expect(await resolveTarget("https://example.com", { ...base, timeoutMs: 10, lookup: () => new Promise(() => {}) }))
    .toEqual({ ok: false, reason: "timeout" });
});
