// Generates API keys and hashes them without storing their secret text.
import { createHash, randomBytes } from "node:crypto";

// Step 1: the public format and the one-way hash stored in Postgres.
export const KEY_PREFIX = "relay_live_";
export const KEY_RANDOM_LENGTH = 43;

export function hashApiKey(key: string): Buffer {
  return createHash("sha256").update(key, "utf8").digest();
}

export function generateApiKey(): { key: string; prefix: string; hash: Buffer } {
  const random = randomBytes(32).toString("base64url");
  const key = KEY_PREFIX + random;
  return { key, prefix: KEY_PREFIX + random.slice(0, 4), hash: hashApiKey(key) };
}

// Step 2: check the header before any database query.
// The word "Bearer" is case-insensitive (RFC 9110), so "bearer" and "BEARER" work too.
// The key after exactly one space is strict: KEY_PREFIX + KEY_RANDOM_LENGTH base64url characters.
// Every failure returns the same null (and so the same 401), so nobody learns which part was wrong.
const SCHEME = "bearer ";
const KEY_REGEX = new RegExp(`^${KEY_PREFIX}[A-Za-z0-9_-]{${KEY_RANDOM_LENGTH}}$`);

export function parseBearerKey(header: string | undefined): string | null {
  if (typeof header !== "string") return null;
  if (header.slice(0, SCHEME.length).toLowerCase() !== SCHEME) return null;
  const key = header.slice(SCHEME.length);
  return KEY_REGEX.test(key) ? key : null;
}

