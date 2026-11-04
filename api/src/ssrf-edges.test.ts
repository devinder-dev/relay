// Checks first and last IPv4 addresses in reserved ranges and ordinary public neighbours.
import { expect, test } from "bun:test";
import { checkEndpointUrl } from "./ssrf.ts";

const options = { allowOrigins: [], lookup: async () => { throw new Error("Literal must not resolve"); } };
// Step 1: both ends of every reserved block are refused.
const ranges = [
  ["0.0.0.0", "0.255.255.255"], ["10.0.0.0", "10.255.255.255"],
  ["100.64.0.0", "100.127.255.255"], ["127.0.0.0", "127.255.255.255"],
  ["169.254.0.0", "169.254.255.255"], ["172.16.0.0", "172.31.255.255"],
  ["192.0.0.0", "192.0.0.255"], ["192.0.2.0", "192.0.2.255"],
  ["192.88.99.0", "192.88.99.255"], ["192.168.0.0", "192.168.255.255"],
  ["198.18.0.0", "198.19.255.255"], ["198.51.100.0", "198.51.100.255"],
  ["203.0.113.0", "203.0.113.255"], ["224.0.0.0", "239.255.255.255"],
  ["240.0.0.0", "255.255.255.255"],
];
for (const address of ranges.flat()) {
  test(`refuses reserved edge ${address}`, async () => {
    await expect(checkEndpointUrl(`https://${address}/`, options)).rejects.toMatchObject({
      status: 422, code: "invalid_endpoint_url", message: "Endpoint URL must point only to public internet addresses",
    });
  });
}
// Step 2: ordinary addresses immediately outside the blocks are accepted.
for (const address of ["1.0.0.0", "9.255.255.255", "11.0.0.0", "100.63.255.255", "100.128.0.0",
  "126.255.255.255", "128.0.0.0", "169.253.255.255", "169.255.0.0", "172.15.255.255", "172.32.0.0",
  "191.255.255.255", "192.0.1.0", "192.0.1.255", "192.0.3.0", "192.88.98.255", "192.88.100.0",
  "192.167.255.255", "192.169.0.0", "198.17.255.255", "198.20.0.0", "198.51.99.255", "198.51.101.0",
  "203.0.112.255", "203.0.114.0", "223.255.255.255"]) {
  test(`accepts public neighbour ${address}`, async () => {
    await expect(checkEndpointUrl(`https://${address}/`, options)).resolves.toBeUndefined();
  });
}
