// Checks key generation and defines the header parser's required behavior.
import { describe, expect, test } from "bun:test";
import { generateApiKey, hashApiKey, parseBearerKey } from "./api-key.ts";

const key = "relay_live_" + "a".repeat(43);

// Step 1: schemes are case-insensitive, but the separator is one space.
describe("parseBearerKey", () => {
  for (const scheme of ["Bearer", "bearer", "BEARER"]) {
    test(`${scheme} with a valid key returns the key`, () => {
      expect(parseBearerKey(`${scheme} ${key}`)).toBe(key);
    });
  }
  const invalid: [string, string | undefined][] = [
    ["undefined", undefined], ["empty", ""], ["Basic", "Basic abc"], ["scheme alone", "Bearer"],
    ["two spaces", `Bearer  ${key}`], ["tab", `Bearer\t${key}`], ["trailing space", `Bearer ${key} `],
    ["test prefix", "Bearer relay_test_" + "a".repeat(43)],
    ["42 characters", "Bearer relay_live_" + "a".repeat(42)],
    ["44 characters", "Bearer relay_live_" + "a".repeat(44)],
    ...["+", "/", "="].map((character): [string, string] =>
      [character, "Bearer relay_live_" + "a".repeat(42) + character]),
    ["combined headers", `Bearer ${key}, Bearer ${key}`],
  ];
  for (const [name, header] of invalid) {
    test(`rejects ${name}`, () => expect(parseBearerKey(header)).toBeNull());
  }
});

// Step 2: randomness, public prefix and database hash describe the same key.
describe("generateApiKey", () => {
  test("has the exact key format and a safe 15-character prefix", () => {
    const generated = generateApiKey();
    expect(generated.key).toMatch(/^relay_live_[A-Za-z0-9_-]{43}$/);
    expect(generated.prefix).toBe(generated.key.slice(0, 15));
  });
  test("two generated keys differ", () => expect(generateApiKey().key).not.toBe(generateApiKey().key));
  test("hash matches SHA-256 of the key and has 32 bytes", () => {
    const generated = generateApiKey();
    expect(generated.hash).toEqual(hashApiKey(generated.key));
    expect(generated.hash.length).toBe(32);
  });
});
