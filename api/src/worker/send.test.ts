// Checks local HTTP outcomes, headers, excerpts and cleanup under one deadline.
import { expect, test } from "bun:test";
import { sendFixture } from "../../test/send-fixture.ts";

const f = sendFixture();
// Step 1: final headers determine the outcome, including redirects without a second request.
for (const status of [200, 204, 500, 302]) {
  test(`HTTP ${status} retains its outcome and never follows a redirect`, async () => {
    let hits = 0, redirected = 0;
    const target = await f.start((_req, res) => { redirected++; res.end(); });
    const s = await f.start((req, res) => {
      hits++;
      expect(req.url).toBe("/hooks?q=1");
      expect(req.headers["content-type"]).toBe("application/json");
      expect(req.headers["content-length"]).toBe(String(Buffer.byteLength('{"hello":"😀"}')));
      expect(req.headers["webhook-id"]).toBe("test-event");
      res.writeHead(status, { location: target.origin + "/redirect-target" }); res.end();
    });
    const result = await s.send();
    expect(result.statusCode).toBe(status);
    expect(result.error).toBe(status === 302 ? "redirect" : null);
    expect(result.excerpt).toBe("");
    await Bun.sleep(20);
    expect(hits).toBe(1);
    expect(redirected).toBe(0);
  });
}
test("a large first chunk is cut to 1024 bytes", async () => {
  const s = await f.start((_req, res) => res.end("x".repeat(4096)));
  const result = await s.send();
  expect(result.excerpt).toBe("x".repeat(1024));
  expect(result.error).toBeNull();
});
test("invalid UTF-8 is replaced and NUL is removed after decoding", async () => {
  const s = await f.start((_req, res) => res.end(Buffer.from([0x61, 0, 0xff, 0x62])));
  expect((await s.send()).excerpt).toBe("a�b");
});
// Step 2: a deadline cannot change a status already received.
for (const trickle of [false, true]) {
  test(`an endless ${trickle ? "trickle" : "short body"} keeps its header outcome`, async () => {
    const s = await f.start((_req, res) => {
      res.writeHead(200); res.write("a");
      if (trickle) {
        const timer = setInterval(() => res.write("b"), 5);
        res.on("close", () => clearInterval(timer));
      }
    });
    const result = await s.send({ deadlineMs: 50 });
    expect(result.statusCode).toBe(200);
    expect(result.error).toBeNull();
    expect(result.excerpt!.startsWith("a")).toBe(true);
    expect(result.excerpt!.length).toBeLessThanOrEqual(1024);
  });
}
test("headers that never arrive time out", async () => {
  const s = await f.start(() => {});
  expect((await s.send({ deadlineMs: 30 })).error).toBe("timeout");
});
test("one real ten-second deadline ends a silent peer", async () => {
  const s = await f.start(() => {});
  const start = performance.now();
  const result = await s.send({ deadlineMs: 10_000 });
  expect(result.error).toBe("timeout");
  expect(performance.now() - start).toBeGreaterThanOrEqual(9_900);
  expect(performance.now() - start).toBeLessThan(12_000);
}, 15_000);
