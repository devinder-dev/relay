// Checks that authenticated dashboard requests can read the API response and request id.
import { expect, test } from "bun:test";
import { eventsFixture } from "./events-fixture.ts";

const f = eventsFixture();
// Step 1: use a real key so CORS is checked together with successful authentication.
test("GET me from the dashboard returns identity and exposed request id", async () => {
  const a = await f.owner();
  const res = await f.app.inject({ url: "/v1/me", headers: {
    origin: "https://cdn.myrelay.tech", authorization: `Bearer ${a.key}`,
  } });
  expect(res.statusCode).toBe(200);
  expect(res.json().owner.id).toBe(a.owner.id);
  expect(res.headers["access-control-allow-origin"]).toBe("https://cdn.myrelay.tech");
  expect(res.headers["access-control-expose-headers"]).toContain("x-request-id");
});
