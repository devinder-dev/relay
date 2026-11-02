// The connection itself, against the real Postgres: who we are, which settings arrive, and what
// happens when the login is wrong, a query hangs, or a connection is cut.
import { afterAll, describe, expect, test } from "bun:test";
import { isDatabaseUnavailable, waitForDatabase } from "../../src/db.ts";
import { DATABASE_URL, silentLog, testDb } from "./helpers.ts";

const sql = testDb();
afterAll(() => sql.end({ timeout: 5 }));

describe("the connection, against the real Postgres", () => {
  test("logs in as relay, which is not a superuser and can't create roles or databases", async () => {
    const [me] = await sql`
      select current_user as name, current_database() as database,
             rolsuper, rolcreaterole, rolcreatedb
      from pg_roles where rolname = current_user`;
    expect(me).toEqual({ name: "relay", database: "relay", rolsuper: false, rolcreaterole: false, rolcreatedb: false });
  });

  test("our settings arrive on every connection: application_name and statement_timeout", async () => {
    const [settings] = await sql`
      select current_setting('application_name') as app, current_setting('statement_timeout') as timeout`;
    expect(settings).toEqual({ app: "relay-api", timeout: "5s" });
  });

  test("waitForDatabase returns at once when the database is up", async () => {
    await waitForDatabase(sql, silentLog);
  });

  test("a wrong password → waitForDatabase gives up at the first answer with 28P01, no retry", async () => {
    const wrong = new URL(DATABASE_URL);
    wrong.password = `wrong-${crypto.randomUUID()}`;
    const bad = testDb({ url: wrong.toString() });
    // No stopwatch (a slow runner would make it flaky): "no ⚠️ retry line" proves it didn't wait.
    const warnings: string[] = [];
    const log = { info: () => {}, warn: (_obj: object, msg: string) => warnings.push(msg) };
    try {
      await expect(waitForDatabase(bad, log)).rejects.toMatchObject({ code: "28P01" });
      expect(warnings).toEqual([]);
    } finally {
      await bad.end({ timeout: 1 });
    }
  });

  test("a stuck query is cancelled by statement_timeout, with 57014", async () => {
    // pg_sleep(6) would succeed after 6 s; the 57014 error alone proves Postgres stopped it.
    await expect(sql`select pg_sleep(6)`).rejects.toMatchObject({ code: "57014" });
  }, 15_000);

  test("a dropped connection comes back: the next query opens a new one", async () => {
    // A pool of exactly one connection, so a different pid can only mean a new connection.
    const one = testDb({ poolMax: 1 });
    const other = testDb();
    const pid = async () => (await one`select pg_backend_pid() as pid`)[0]!.pid as number;
    try {
      const before = await pid();
      // The other pool ends ours, as a Postgres restart or a cut network would. relay may end
      // its own sessions without being a superuser. The 2000 = wait until it's really gone.
      const [result] = await other`select pg_terminate_backend(${before}, 2000) as ended`;
      expect(result!.ended).toBe(true);
      // The client may not have noticed the cut yet, so one connection error is allowed (in
      // production that request gets our 503). The query after it must work.
      let after: number;
      try {
        after = await pid();
      } catch (error) {
        expect(isDatabaseUnavailable(error)).toBe(true);
        after = await pid();
      }
      expect(after).not.toBe(before);
    } finally {
      await Promise.all([one.end({ timeout: 1 }), other.end({ timeout: 1 })]);
    }
  });
});
