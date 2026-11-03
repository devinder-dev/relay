// Defines URL validation with fake DNS, apart from the explicit localhost resolver check.
import { expect, test } from "bun:test";
import { allAddressesPublic, checkEndpointUrl, realLookup, type Lookup } from "./ssrf.ts";

const PUBLIC = "Endpoint URL must point only to public internet addresses";
const fake: Lookup = async () => ["93.184.215.14"];
async function refused(raw: string, message: string, lookup: Lookup = fake, timeoutMs?: number) {
  await expect(checkEndpointUrl(raw, { lookup, timeoutMs, allowOrigins: [] }))
    .rejects.toMatchObject({ status: 422, code: "invalid_endpoint_url", message });
}

// Step 1: shape and local names are rejected before DNS can leak information.
const shapes: [string, string][] = [
  ["http://example.com/", "Endpoint URL must use https"],
  ["https://user:pw@example.com/", "Endpoint URL must not contain a user name or password"],
  ["https://example.com:8443/", "Endpoint URL must use the default https port (443)"],
  ["https://example.com/a\u0000b", "Endpoint URL must be a valid https URL"],
  ["https://exa\tmple.com/", "Endpoint URL must be a valid https URL"],
  ["not a url", "Endpoint URL must be a valid https URL"],
];
for (const [raw, message] of shapes) test(`refuses shape ${JSON.stringify(raw)}`, () => refused(raw, message));
for (const host of ["localhost", "LOCALHOST.", "intranet", "db.relay.svc.cluster.local", "x.internal", "x.local", "x.localhost", "x.svc"]) {
  test(`refuses local name ${host} without lookup`, async () => {
    let calls = 0;
    await refused(`https://${host}/`, PUBLIC, async () => { calls++; return []; });
    expect(calls).toBe(0);
  });
}

// Step 2: literals bypass DNS, including addresses normalized by the URL parser.
for (const host of ["127.0.0.1", "0x7f.1", "2130706433", "127.1", "0", "10.43.0.1", "169.254.169.254",
  "100.64.0.1", "81.88.23.71", "[::1]", "[::]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]",
  "[::127.0.0.1]", "[::10.0.0.1]", "[1::1]", "[4000::1]", "[fe80::1]", "[fd00::1]",
  "[64:ff9b::7f00:1]", "[64:ff9b:1::1]", "[2002:7f00:1::]", "[2001::1]", "[2001:db8::1]", "[::ffff:81.88.23.71]"]) {
  test(`refuses literal ${host} without lookup`, async () => {
    let calls = 0;
    await refused(`https://${host}/`, PUBLIC, async () => { calls++; return []; });
    expect(calls).toBe(0);
  });
}
test("mixed public/private DNS is refused", () => refused("https://example.com/", PUBLIC, async () => ["8.8.8.8", "10.0.0.5"]));
test("empty DNS is refused", () => refused("https://example.com/", PUBLIC, async () => []));
test("DNS errors are refused", () => refused("https://example.com/", PUBLIC, async () => {
  throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
}));
test("DNS timeout refuses a lookup that never answers", () =>
  refused("https://example.com/", PUBLIC, () => new Promise(() => {}), 20));
test("late lookup rejection is handled after the timeout", async () => {
  await refused("https://example.com/", PUBLIC, () => new Promise((_, reject) => {
    setTimeout(() => reject(new Error("late DNS failure")), 30);
  }), 5);
  await Bun.sleep(40);
});
test("private and unresolved destinations have identical error bodies", async () => {
  async function body(lookup: Lookup) {
    try { await checkEndpointUrl("https://example.com/", { lookup, allowOrigins: [] }); }
    catch (error) {
      const e = error as { code: string; message: string };
      return { error: { code: e.code, message: e.message } };
    }
    throw new Error("Expected rejection");
  }
  expect(await body(async () => ["10.0.0.1"])).toEqual(await body(async () => { throw new Error("ENOTFOUND"); }));
});

// Step 3: valid public URLs remain red until allAddressesPublic is implemented.
for (const raw of ["https://8.8.8.8/", "https://[2606:4700::1111]/", "https://example.com/", "https://example.com:443/"]) {
  test(`accepts public ${raw}`, async () => {
    await expect(checkEndpointUrl(raw, { allowOrigins: [], lookup: async () =>
      ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"] })).resolves.toBeUndefined();
  });
}
test("lookup receives the hostname with its final dot", async () => {
  let received = "";
  await refused("https://example.com./", PUBLIC, async (hostname) => { received = hostname; return []; });
  expect(received).toBe("example.com.");
});
test("realLookup localhost includes IPv4 loopback", async () => {
  const addresses = await realLookup("localhost");
  expect(addresses).toContain("127.0.0.1");
  expect(addresses.every((address) => typeof address === "string")).toBe(true);
});

// Step 4: operators may allow only an exact origin, never credentials.
const origin = "http://receiver.relay-demo.svc.cluster.local:8080";
test("exact operator origin skips DNS and address checks", async () => {
  let calls = 0;
  await expect(checkEndpointUrl(origin + "/hook", { allowOrigins: [origin], lookup: async () => {
    calls++; return [];
  } })).resolves.toBeUndefined();
  expect(calls).toBe(0);
});
for (const raw of [origin.replace(":8080", ":8081"), origin.replace("http:", "https:"),
  origin.replace("receiver.", "other."), origin.replace("http://", "http://user:pw@")]) {
  test(`operator exception refuses ${raw}`, async () => {
    await expect(checkEndpointUrl(raw, { allowOrigins: [origin], lookup: fake }))
      .rejects.toMatchObject({ status: 422, code: "invalid_endpoint_url" });
  });
}

// Step 5: the address rule is safe on its own, not only behind checkEndpointUrl.
test("allAddressesPublic fails closed on its own", () => {
  expect(allAddressesPublic([])).toBe(false);
  expect(allAddressesPublic(["not-an-ip"])).toBe(false);
  expect(allAddressesPublic(["8.8.8.8", "not-an-ip"])).toBe(false);
});
test("allAddressesPublic judges a mapped address as the IPv4 it connects to", () => {
  expect(allAddressesPublic(["::ffff:8.8.8.8"])).toBe(true);
  expect(allAddressesPublic(["::ffff:7f00:1"])).toBe(false);
});
