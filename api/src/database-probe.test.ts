import { expect, test } from "bun:test";
import { checkDatabase } from "./database-probe.ts";
import { Metrics } from "./metrics.ts";

test("database probe reports an independent successful query", async () => {
  const metrics = new Metrics();
  await checkDatabase(async () => {}, metrics, { warn: () => { throw new Error("unexpected warning"); } });
  expect(metrics.render()).toContain("relay_database_query_success 1");
  expect(metrics.render()).toContain('relay_database_query_checks_total{outcome="success"} 1');
});

test("database probe records failure without throwing or leaking the error", async () => {
  const metrics = new Metrics();
  const warnings: unknown[] = [];
  await checkDatabase(async () => { throw new Error("postgres://secret@example.test"); }, metrics, {
    warn: (fields) => warnings.push(fields),
  });
  const output = metrics.render();
  expect(output).toContain("relay_database_query_success 0");
  expect(output).toContain('relay_database_query_checks_total{outcome="error"} 1');
  expect(JSON.stringify(warnings)).not.toContain("secret");
});
