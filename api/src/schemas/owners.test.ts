// Checks owner names, including NUL which cannot be passed through process arguments.
import { expect, test } from "bun:test";
import { OwnerName } from "./owners.ts";

// Step 1: reject unsafe text before Postgres sees it.
test("owner names reject empty text, control characters and more than 100 characters", () => {
  for (const name of ["", "Acme\u0000", "Acme\n", "x".repeat(101), "😀".repeat(101)]) {
    expect(OwnerName.safeParse(name).success).toBe(false);
  }
  expect(OwnerName.parse("Acme Å😀")).toBe("Acme Å😀");
  // Positive controls right at the limit: 100 code points pass, also as 100 emoji (200 UTF-16 units).
  expect(OwnerName.parse("x".repeat(100))).toHaveLength(100);
  expect(OwnerName.safeParse("😀".repeat(100)).success).toBe(true);
});
