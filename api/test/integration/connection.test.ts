// The connection itself, against the real Postgres: who we are, which settings arrive, and what
// happens when the login is wrong, a query hangs, or a connection is cut.
import { afterAll, describe, expect, test } from "bun:test";
import { waitForDatabase } from "../../src/db.ts";
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

  test("a wrong password → waitForDatabase gives up at once with 28P01, no 60 s wait", async () => {
    const wrong = new URL(DATABASE_URL);
    wrong.password = `wrong-${crypto.randomUUID()}`;
    const bad = testDb(wrong.toString());
    const started = performance.now();
    try {
      await expect(waitForDatabase(bad, silentLog)).rejects.toMatchObject({ code: "28P01" });
      expect(performance.now() - started).toBeLessThan(2_000); // shorter than a single pause
    } finally {
      await bad.end({ timeout: 1 });
    }
  });

  test("a stuck query is cancelled by statement_timeout after 5 s, with 57014", async () => {
    const started = performance.now();
    await expect(sql`select pg_sleep(6)`).rejects.toMatchObject({ code: "57014" });
    expect(performance.now() - started).toBeLessThan(5_900); // stopped at 5 s, not finished at 6
  }, 10_000);

  test("a dropped connection comes back: the next query opens a new one", async () => {
    const [before] = await sql`select pg_backend_pid() as pid`;
    // A separate connection ends ours, as a Postgres restart or a cut network would. relay may
    // end its own sessions without being a superuser. The 2 s = wait until it's really gone.
    const other = testDb();
    try {
      const [result] = await other`select pg_terminate_backend(${before!.pid}, 2000) as ended`;
      expect(result!.ended).toBe(true);
    } finally {
      await other.end({ timeout: 1 });
    }
    const [after] = await sql`select pg_backend_pid() as pid`;
    expect(after!.pid).not.toBe(before!.pid);
  });
});
