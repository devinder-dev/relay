// Checks endpoint URL shape and resolved addresses before a customer URL can be stored.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { invalidEndpointUrl } from "./errors.ts";

const VPS_ADDRESS = "81.88.23.71";
const GLOBAL_UNICAST_V6 = ipaddr.IPv6.parseCIDR("2000::/3");
const LOOKUP_TIMEOUT_MS = 3_000;
const PUBLIC_MESSAGE = "Endpoint URL must point only to public internet addresses";
export type Lookup = (hostname: string) => Promise<string[]>;
export const realLookup: Lookup = async (hostname) =>
  (await lookup(hostname, { all: true })).map((answer) => answer.address);

export async function checkEndpointUrl(
  raw: string,
  options: { lookup: Lookup; allowOrigins: string[]; timeoutMs?: number },
): Promise<void> {
  // Step 1: reject text the URL parser would silently alter before checking its origin.
  if (/[\p{Cc}\s]/u.test(raw)) throw invalidEndpointUrl("Endpoint URL must be a valid https URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidEndpointUrl("Endpoint URL must be a valid https URL");
  }
  if (url.username || url.password) throw invalidEndpointUrl("Endpoint URL must not contain a user name or password");
  if (options.allowOrigins.includes(url.origin)) return;
  if (url.protocol !== "https:") throw invalidEndpointUrl("Endpoint URL must use https");
  if (url.port !== "") throw invalidEndpointUrl("Endpoint URL must use the default https port (443)");

  // Step 2: literal addresses need no DNS; URL already normalizes unusual IPv4 spellings.
  const hostname = url.hostname;
  let addresses: string[];
  if (hostname.startsWith("[")) {
    addresses = [hostname.slice(1, -1)];
  } else if (isIP(hostname) === 4) {
    addresses = [hostname];
  } else {
    // Step 3: compare without a final dot, but resolve the name exactly as written.
    const name = hostname.replace(/\.$/, "");
    if (name === "localhost" || !name.includes(".") ||
      [".local", ".localhost", ".internal", ".svc", ".cluster.local"].some((suffix) => name.endsWith(suffix))) {
      throw invalidEndpointUrl(PUBLIC_MESSAGE);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Lookup timed out")), options.timeoutMs ?? LOOKUP_TIMEOUT_MS);
    });
    try {
      addresses = await Promise.race([options.lookup(hostname), timeout]);
      if (addresses.length === 0) throw invalidEndpointUrl(PUBLIC_MESSAGE);
    } catch {
      throw invalidEndpointUrl(PUBLIC_MESSAGE);
    } finally {
      clearTimeout(timer);
    }
  }
  if (!allAddressesPublic(addresses)) throw invalidEndpointUrl(PUBLIC_MESSAGE);
}

// Step 4: every address must be a plain internet address.
export function allAddressesPublic(addresses: string[]): boolean {
  if (addresses.length === 0) return false;
  for (const address of addresses) {
    try {
      const parsed = ipaddr.process(address);
      if (parsed.range() !== "unicast" || parsed.toString() === VPS_ADDRESS) return false;
      if (parsed instanceof ipaddr.IPv6 && !parsed.match(GLOBAL_UNICAST_V6)) return false;
    } catch {
      return false;
    }
  }
  return true;
}
