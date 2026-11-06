// Proves private targets never connect and TLS checks the hostname at a pinned address.
import { afterAll, expect, spyOn, test } from "bun:test";
import { sendFixture } from "../../test/send-fixture.ts";
import { tlsFixture } from "../../test/tls-fixture.ts";
import { sendWebhook } from "./send.ts";
import http from "node:http";

const f = sendFixture();
// Step 1: validation rejects every mixed/private answer before constructing a socket.
for (const addresses of [["127.0.0.1"], ["::1"], ["::ffff:127.0.0.1"], ["10.0.0.5"], ["8.8.8.8", "127.0.0.1"]]) {
  test(`blocks ${addresses.join(",")}`, async () => {
    let hits = 0;
    const s = await f.start((_req, res) => { hits++; res.end(); });
    const result = await s.send({ allowOrigins: [], lookup: async () => addresses });
    // HTTP itself is forbidden; HTTPS exercises the actual address rule below.
    const secure = await sendWebhook({ url: "https://receiver.test/hooks", body: Buffer.from("{}"), headers: {} }, {
      allowOrigins: [], lookup: async () => addresses, deadlineMs: 100,
    });
    expect(result.error).toBe("blocked_address");
    expect(secure.error).toBe("blocked_address");
    expect(hits).toBe(0);
  });
}
test("an origin on another port is not an exception", async () => {
  const s = await f.start((_req, res) => res.end());
  expect((await s.send({ allowOrigins: [s.origin + "0"] })).error).toBe("blocked_address");
});
test("DNS failure and a stalled lookup have separate outcomes; a late answer starts nothing", async () => {
  let hits = 0;
  const s = await f.start((_req, res) => { hits++; res.end(); });
  expect((await s.send({ lookup: async () => { throw new Error("DNS"); } })).error).toBe("connect_failed");
  expect((await s.send({ lookup: () => new Promise(() => {}), deadlineMs: 25 })).error).toBe("timeout");
  let answer!: (value: string[]) => void;
  expect((await s.send({ deadlineMs: 20, lookup: () => new Promise((resolve) => { answer = resolve; }) })).error).toBe("timeout");
  answer(["127.0.0.1"]); await Bun.sleep(5);
  expect(hits).toBe(0);
});
test("two sends each resolve once and use the first checked answer", async () => {
  const s = await f.start((_req, res) => res.end("ok"));
  let calls = 0;
  const lookup = async () => { calls++; return calls <= 2 ? ["127.0.0.1"] : ["127.0.0.2"]; };
  const request = spyOn(http, "request");
  try {
    expect((await s.send({ lookup })).statusCode).toBe(200);
    expect((await s.send({ lookup })).statusCode).toBe(200);
    expect(calls).toBe(2);
    // Keep the explicit no-reuse guard even when excerpt cleanup also destroys sockets.
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ agent: false }), expect.any(Function));
  } finally { request.mockRestore(); }
});
// Step 2: a trusted CA is injected, while hostname verification remains enabled.
const certificates: Awaited<ReturnType<typeof tlsFixture>>[] = [];
afterAll(async () => { for (const cert of certificates) await cert.close(); });
for (const host of ["receiver.test", "other.test"]) {
  test(`pinned TLS with certificate for ${host}`, async () => {
    const certificate = await tlsFixture(host); certificates.push(certificate);
    const s = await f.start((_req, res) => res.end("secure"), certificate);
    let calls = 0;
    const result = await s.send({ ca: certificate.ca, deadlineMs: 2000, lookup: async () => {
      calls++; return calls === 1 ? ["127.0.0.1"] : ["127.0.0.2"];
    } });
    expect(calls).toBe(1);
    expect(result.error).toBe(host === "receiver.test" ? null : "tls");
    expect(result.statusCode).toBe(host === "receiver.test" ? 200 : null);
  });
}
