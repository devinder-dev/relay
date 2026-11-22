import { expect, test } from "bun:test";
import { createDatabaseProbe } from "./database-probe.ts";
import { Metrics } from "./metrics.ts";

const sleep = (ms: number) => Bun.sleep(ms);

test("database probe records successful and failed queries", async () => {
  const success = new Metrics(), failed = new Metrics(), warnings: object[] = [];
  const good = createDatabaseProbe(async () => {}, success, { warn: () => { throw new Error("unexpected warning"); } }, { intervalMs: 10_000, timeoutMs: 20 });
  const bad = createDatabaseProbe(async () => { throw new Error("postgres://secret@example.test"); }, failed, { warn: (fields) => warnings.push(fields) }, { intervalMs: 10_000, timeoutMs: 20 });
  try {
    await sleep(2);
    expect(success.render()).toContain("relay_database_query_success 1");
    expect(failed.render()).toContain("relay_database_query_success 0");
    expect(JSON.stringify(warnings)).not.toContain("secret");
  } finally { good.stop(); bad.stop(); }
});

test("a timed-out query turns unhealthy and blocks overlapping scheduled probes", async () => {
  const pending = Promise.withResolvers<void>(), metrics = new Metrics(), warnings: object[] = [];
  let calls = 0;
  const probe = createDatabaseProbe(() => { calls++; return pending.promise; }, metrics, { warn: (fields) => warnings.push(fields) }, { intervalMs: 5, timeoutMs: 10 });
  try {
    await sleep(25);
    expect(calls).toBe(1);
    expect(probe.isInFlight()).toBe(true);
    expect(probe.run()).toBe(false);
    expect(metrics.render()).toContain("relay_database_query_success 0");
    expect(warnings).toContainEqual({ error_type: "probe_timeout" });
  } finally {
    pending.resolve();
    await sleep(1);
    probe.stop();
  }
});

test("a late timed-out completion is ignored and a later probe can recover", async () => {
  const first = Promise.withResolvers<void>(), metrics = new Metrics();
  let calls = 0;
  const probe = createDatabaseProbe(() => { calls++; return calls === 1 ? first.promise : Promise.resolve(); }, metrics, { warn: () => {} }, { intervalMs: 10_000, timeoutMs: 5 });
  try {
    await sleep(10);
    expect(metrics.render()).toContain("relay_database_query_success 0");
    first.resolve();
    await sleep(1);
    expect(probe.isInFlight()).toBe(false);
    expect(probe.run()).toBe(true);
    await sleep(1);
    expect(metrics.render()).toContain("relay_database_query_success 1");
    expect(calls).toBe(2);
  } finally { probe.stop(); }
});

test("stopping a probe prevents future starts without waiting for a hung query", async () => {
  const pending = Promise.withResolvers<void>();
  let calls = 0;
  const probe = createDatabaseProbe(() => { calls++; return pending.promise; }, new Metrics(), { warn: () => {} }, { intervalMs: 5, timeoutMs: 100 });
  probe.stop();
  await sleep(15);
  expect(calls).toBe(1);
  expect(probe.run()).toBe(false);
  pending.resolve();
});
