// Unit tests for db.ts: no real database. A fake "sql" answers from a script (ok, or an error
// code), and a fake clock lets 60 seconds of retries pass in a few milliseconds.
import { describe, expect, test } from "bun:test";
import { isDatabaseUnavailable, pingDatabase, waitForDatabase, type Log, type Sql } from "./db.ts";

type Outcome = "ok" | string; // "ok", or the error code the database "throws"

// A fake sql: each call takes the next outcome from the script; the last one repeats forever.
function fakeDb(script: Outcome[]) {
  let calls = 0;
  const sql = (() => {
    const outcome = script[Math.min(calls, script.length - 1)];
    calls++;
    if (outcome === "ok") return Promise.resolve([{ "?column?": 1 }]);
    return Promise.reject(Object.assign(new Error(`fake ${outcome}`), { code: outcome }));
  }) as unknown as Sql;
  return { sql, calls: () => calls };
}

// A fake clock: sleep() moves the time forward instead of waiting.
function fakeClock() {
  let t = 0;
  const pauses: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => { pauses.push(ms); t += ms; },
    pauses,
    elapsed: () => t,
  };
}

// A fake logger that remembers the messages.
function fakeLog() {
  const info: string[] = [];
  const warn: string[] = [];
  const log: Log = { info: (_o, msg) => info.push(msg), warn: (_o, msg) => warn.push(msg) };
  return { log, info, warn };
}

describe("waitForDatabase", () => {
  test("the database answers at once → returns, no pause, logs ✅", async () => {
    const db = fakeDb(["ok"]), clock = fakeClock(), out = fakeLog();
    await waitForDatabase(db.sql, out.log, clock);
    expect(db.calls()).toBe(1);
    expect(clock.pauses).toEqual([]);
    expect(out.info.join(" ")).toContain("✅");
  });

  test("refused twice (Postgres still starting), then answers → 3 tries, 2 pauses of 2 s", async () => {
    const db = fakeDb(["ECONNREFUSED", "ECONNREFUSED", "ok"]), clock = fakeClock(), out = fakeLog();
    await waitForDatabase(db.sql, out.log, clock);
    expect(db.calls()).toBe(3);
    expect(clock.pauses).toEqual([2000, 2000]);
    expect(out.warn.length).toBe(2);
  });

  test('"still starting up" (57P03) is retried, not fatal', async () => {
    const db = fakeDb(["57P03", "ok"]), clock = fakeClock(), out = fakeLog();
    await waitForDatabase(db.sql, out.log, clock);
    expect(db.calls()).toBe(2);
  });

  test("does not start another attempt when the next pause reaches the deadline", async () => {
    const db = fakeDb(["ECONNREFUSED", "ok"]), clock = fakeClock(), out = fakeLog();
    await expect(waitForDatabase(db.sql, out.log, { ...clock, deadlineMs: 2_000 }))
      .rejects.toThrow("Database not reachable within 2000 ms");
    expect(db.calls()).toBe(1);
    expect(clock.pauses).toEqual([]);
  });

  test("a thrown null is retried safely", async () => {
    let calls = 0;
    const sql = (() => ++calls === 1 ? Promise.reject(null) : Promise.resolve([])) as unknown as Sql;
    const clock = fakeClock(), out = fakeLog();
    await waitForDatabase(sql, out.log, clock);
    expect(calls).toBe(2);
    expect(clock.pauses).toEqual([2000]);
  });

  test("a stalled query is limited by the remaining startup deadline", async () => {
    const sql = (() => new Promise(() => {})) as unknown as Sql;
    const out = fakeLog();
    await expect(waitForDatabase(sql, out.log, { deadlineMs: 20 }))
      .rejects.toThrow("Database not reachable within 20 ms");
    expect(out.warn).toEqual([]);
  });

  const fatal = [["28P01", "wrong password"], ["28000", "login not allowed"], ["3D000", "no such database"]] as const;
  for (const [code, meaning] of fatal) {
    test(`${meaning} (${code}) → throws at once, no retry, no pause`, async () => {
      const db = fakeDb([code, "ok"]), clock = fakeClock(), out = fakeLog();
      await expect(waitForDatabase(db.sql, out.log, clock)).rejects.toMatchObject({ code });
      expect(db.calls()).toBe(1);
      expect(clock.pauses).toEqual([]);
    });
  }

  test("never reachable → gives up after the 60 s deadline, never sleeps past it", async () => {
    const db = fakeDb(["ECONNREFUSED"]), clock = fakeClock(), out = fakeLog();
    await expect(waitForDatabase(db.sql, out.log, clock)).rejects.toThrow();
    expect(clock.elapsed()).toBeLessThanOrEqual(60_000);
    expect(db.calls()).toBeGreaterThanOrEqual(30); // about one try every 2 s for 60 s
    expect(db.calls()).toBeLessThanOrEqual(31);
  });

  test("the deadline and the pause can be set (a shorter wait for tests and the laptop)", async () => {
    const db = fakeDb(["ETIMEDOUT"]), clock = fakeClock(), out = fakeLog();
    await expect(waitForDatabase(db.sql, out.log, { ...clock, deadlineMs: 5_000, pauseMs: 1_000 })).rejects.toThrow();
    expect(clock.elapsed()).toBeLessThanOrEqual(5_000);
    expect(db.calls()).toBeGreaterThanOrEqual(5); // a try about every second for 5 s
    expect(clock.pauses.every((ms) => ms === 1_000)).toBe(true);
  });
});

describe("pingDatabase", () => {
  test("a try that times out is abandoned, and its late error is still handled (no crash)", async () => {
    // The database answers with an error only after the try has given up.
    const sql = (() =>
      new Promise((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error("late"), { code: "ECONNRESET" })), 30),
      )) as unknown as Sql;
    await expect(pingDatabase(sql, 10)).rejects.toMatchObject({ code: "PING_TIMEOUT" });
    // Let the late error arrive: bun test fails the whole run on an uncaught one.
    await Bun.sleep(50);
  });
});

describe("isDatabaseUnavailable", () => {
  test("connection problems → true (they become 503)", () => {
    for (const code of ["ECONNREFUSED", "CONNECT_TIMEOUT", "CONNECTION_CLOSED", "EPIPE", "EHOSTUNREACH", "57P02", "57P03", "08001", "08006"]) {
      expect(isDatabaseUnavailable({ code })).toBe(true);
    }
  });

  test("everything else → false (it stays a 500: our bug, not an outage)", () => {
    // 23505 duplicate key, 42P01 no such table, 57014 cancelled (slow SQL), 08P01 protocol
    // violation (a driver bug), 08007 commit result unknown ("try again" could save it twice)
    const notOutages = [{ code: "23505" }, { code: "42P01" }, { code: "57014" }, { code: "08P01" }, { code: "08007" }];
    for (const error of [...notOutages, new Error("boom"), null, undefined, "text"]) {
      expect(isDatabaseUnavailable(error)).toBe(false);
    }
  });
});
