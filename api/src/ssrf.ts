// Checks URL shape and resolves destinations once, for creation and safe delivery.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { invalidEndpointUrl } from "./errors.ts";

const VPS_ADDRESS = "81.88.23.71";
const GLOBAL_UNICAST_V6 = ipaddr.IPv6.parseCIDR("2000::/3");
const PUBLIC_MESSAGE = "Endpoint URL must point only to public internet addresses";
export type Lookup = (hostname: string) => Promise<string[]>;
export const realLookup: Lookup = async (hostname) =>
  (await lookup(hostname, { all: true })).map((answer) => answer.address);
export type TargetOptions = { lookup: Lookup; allowOrigins: string[]; timeoutMs?: number };
export type TargetReason = "invalid_url" | "userinfo" | "not_https" | "port" | "local_name" |
  "dns_failed" | "timeout" | "private";
type Target = { ok: true; url: URL; allowListed: boolean };
export type ResolveResult = (Target & { addresses: string[] }) | { ok: false; reason: TargetReason };

// Step 1: shared shape checks run before any origin exception or DNS call.
function parseTarget(raw: string, allowOrigins: string[]): Target | { ok: false; reason: TargetReason } {
  if (/[\p{Cc}\s]/u.test(raw)) return { ok: false, reason: "invalid_url" };
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, reason: "invalid_url" }; }
  if (url.username || url.password) return { ok: false, reason: "userinfo" };
  const allowListed = allowOrigins.includes(url.origin);
  if (!allowListed && url.protocol !== "https:") return { ok: false, reason: "not_https" };
  if (!allowListed && url.port !== "") return { ok: false, reason: "port" };
  return { ok: true, url, allowListed };
}

// Step 2: the sender always resolves, even for an operator-approved internal origin.
export async function resolveTarget(raw: string, options: TargetOptions): Promise<ResolveResult> {
  const target = parseTarget(raw, options.allowOrigins);
  if (!target.ok) return target;
  const host = target.url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    const name = host.replace(/\.$/, "");
    if (!target.allowListed && (name === "localhost" || !name.includes(".") ||
      [".local", ".localhost", ".internal", ".svc", ".cluster.local"].some((suffix) => name.endsWith(suffix)))) {
      return { ok: false, reason: "local_name" };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), options.timeoutMs ?? 3_000);
    });
    try {
      const answer = await Promise.race([options.lookup(host), timeout]);
      if (answer === null) return { ok: false, reason: "timeout" };
      addresses = answer;
    } catch { return { ok: false, reason: "dns_failed" }; }
    finally { clearTimeout(timer); }
  }
  if (!addresses.length) return { ok: false, reason: "dns_failed" };
  if (!target.allowListed && !allAddressesPublic(addresses)) return { ok: false, reason: "private" };
  if (addresses.some((address) => !isIP(address))) return { ok: false, reason: "dns_failed" };
  return { ...target, addresses };
}

// Step 3: creation keeps its existing errors and permits an approved Service before it exists.
export async function checkEndpointUrl(raw: string, options: TargetOptions): Promise<void> {
  const shape = parseTarget(raw, options.allowOrigins);
  if (shape.ok && shape.allowListed) return;
  const result = shape.ok ? await resolveTarget(raw, options) : shape;
  if (result.ok) return;
  const messages: Partial<Record<TargetReason, string>> = {
    invalid_url: "Endpoint URL must be a valid https URL",
    userinfo: "Endpoint URL must not contain a user name or password",
    not_https: "Endpoint URL must use https",
    port: "Endpoint URL must use the default https port (443)",
  };
  throw invalidEndpointUrl(messages[result.reason] ?? PUBLIC_MESSAGE);
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
