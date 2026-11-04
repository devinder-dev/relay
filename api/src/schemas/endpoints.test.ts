// Checks endpoint input independently of DNS and the database.
import { expect, test } from "bun:test";
import { EndpointCreate } from "./endpoints.ts";

const valid = { name: "Acme", url: "https://example.com/hook" };
// Step 1: reject malformed names, URLs, event lists and unknown fields, each for its own
// reason: the issue path proves the case failed on the field it is about ("" = the body itself).
const invalid: [string, object, string][] = [
  ["an empty name", { ...valid, name: "" }, "name"],
  ["a 101-character name", { ...valid, name: "x".repeat(101) }, "name"],
  ["a NUL in the name", { ...valid, name: "a\u0000b" }, "name"],
  ["a missing url", { name: "Acme" }, "url"],
  ["a 2049-character url", { ...valid, url: "x".repeat(2049) }, "url"],
  ["empty event_types", { ...valid, event_types: [] }, "event_types"],
  ["21 event types", { ...valid, event_types: Array(21).fill("a") }, "event_types"],
  ["an event type with a space", { ...valid, event_types: ["Bad Type"] }, "event_types.0"],
  ["an unknown field", { ...valid, unknown: true }, ""],
];
for (const [label, input, path] of invalid) {
  test(`rejects ${label}`, () => {
    const result = EndpointCreate.safeParse(input);
    expect(result.success).toBe(false);
    expect([...new Set(result.error?.issues.map((issue) => issue.path.join(".")))]).toEqual([path]);
  });
}
// Step 2: defaults and duplicates are resolved before the service sees the input.
test("event types default to wildcard", () => expect(EndpointCreate.parse(valid).event_types).toEqual(["*"]));
test("event type duplicates keep the first occurrence", () => {
  expect(EndpointCreate.parse({ ...valid, event_types: ["invoice.paid", "*", "invoice.paid", "a", "*"] }).event_types)
    .toEqual(["invoice.paid", "*", "a"]);
});
