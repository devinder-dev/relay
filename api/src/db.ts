// The database: one connection pool for the whole app (postgres.js), plus the two things
// startup and the error handler need to know about it.
//   createDb()               makes the pool. It doesn't connect yet: the first query does.
//   waitForDatabase()        at startup, waits until the database answers, or stops the app.
//   isDatabaseUnavailable()  "is this error the database being unreachable?" (→ 503)
import postgres from "postgres";
import type { Config } from "./config.ts";

export type Sql = postgres.Sql;

// The logger calls waitForDatabase uses. Fastify's logger (pino) has them; tests pass a fake.
export type Log = {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
};

// Step 1: the pool. Every number here is a limit, so nothing can hang forever.
export function createDb(config: Pick<Config, "DATABASE_URL" | "DB_POOL_MAX">): Sql {
  return postgres(config.DATABASE_URL, {
    max: config.DB_POOL_MAX, // at most this many open connections (5 by default)
    idle_timeout: 30, // close a connection nobody used for 30 s
    connect_timeout: 5, // one attempt to connect may take 5 s
    connection: {
      application_name: "relay-api", // shows up in pg_stat_activity: who holds which connection
      statement_timeout: 5000, // Postgres cancels any query running longer than 5 s
    },
  });
}

// Errors where Postgres has answered, but waiting won't help: the login or the database itself
// is wrong. Their SQLSTATE codes: https://www.postgresql.org/docs/18/errcodes-appendix.html
//   28P01  wrong password (also an unknown user: Postgres doesn't say which, on purpose)
//   28000  login not allowed (no pg_hba.conf rule, or a role without LOGIN)
//   3D000  no such database
// Everything else at startup (refused, timed out, DNS not ready, 57P03 "still starting up")
// means "not there yet", so it's worth trying again.
export const FATAL_STARTUP_CODES = new Set(["28P01", "28000", "3D000"]);

// One try: `select 1`, given up after timeoutMs. connect_timeout only limits connecting; this
// also covers a server that accepted the connection and then stopped answering.
// On timeout the try is abandoned, NOT cancelled. postgres.js 3.4.9's cancel() sends the cancel
// over a new connection and drops that request's promise, so when the database is stuck
// (exactly when we'd cancel) its failure would go uncaught and could crash the API.
// Promise.race still handles the abandoned query's late answer or error. If the database stays
// stuck, the API exits at the deadline, and that closes every connection anyway.
export async function pingDatabase(sql: Sql, timeoutMs = 5_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error(`no answer within ${timeoutMs} ms`), { code: "PING_TIMEOUT" })),
      timeoutMs,
    );
  });
  try {
    await Promise.race([sql`select 1`, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export type WaitOptions = {
  deadlineMs?: number; // give up after this long in total (wall clock)
  pauseMs?: number; // wait this long between two tries
  now?: () => number; // the clock (tests pass a fake one)
  sleep?: (ms: number) => Promise<void>; // the pause (tests pass a fake one)
};

// Step 2: at startup, wait until the database answers a tiny query (select 1), before the app
// opens its port. A fatal error throws at once; anything else is retried every pauseMs until
// deadlineMs has passed on the clock, then throws. Logs ✅ on success and ⚠️ on each retry.
export async function waitForDatabase(sql: Sql, log: Log, options: WaitOptions = {}): Promise<void> {
  const {
    deadlineMs = 60_000,
    pauseMs = 2_000,
    now = () => performance.now(), // only moves forward; Date.now() jumps if the clock is set
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = options;

  const startTime = now();
  const deadlineError = () => new Error(`Database not reachable within ${deadlineMs} ms`);
  while (true) {
    const remainingMs = deadlineMs - (now() - startTime);
    if (remainingMs <= 0) throw deadlineError();
    try {
      await pingDatabase(sql, Math.min(5_000, remainingMs));
      log.info({}, "✅ database answered");
      return;
    } catch (error: unknown) {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === "string" && FATAL_STARTUP_CODES.has(code)) {
        throw error;
      }
      const elapsedTime = now() - startTime;
      if (elapsedTime + pauseMs >= deadlineMs) {
        throw deadlineError();
      }
      log.warn({ code }, "⚠️ database not reachable yet, retrying");
      await sleep(pauseMs);
    }
  }
}

// Connection problems, as postgres.js and Node report them. These mean "the database isn't
// reachable right now", so the error handler answers 503 (try again shortly) instead of 500.
// Anything else from the database (a broken query, a duplicate key) stays a 500: it's our bug,
// not an outage, and must never be hidden as one.
const UNAVAILABLE_CODES = new Set([
  "CONNECT_TIMEOUT", // postgres.js: connecting took longer than connect_timeout
  "CONNECTION_CLOSED", // postgres.js: the connection dropped
  "CONNECTION_DESTROYED", // postgres.js: the pool was closed during shutdown
  "CONNECTION_ENDED", // postgres.js: a query arrived after the pool was closed (shutdown)
  "ECONNREFUSED", // Node: nothing listens on the port (Postgres down or restarting)
  "ECONNRESET", // Node: the connection was cut
  "EPIPE", // Node: wrote to a connection that was already closed
  "ETIMEDOUT", // Node: the network didn't answer
  "EHOSTUNREACH", // Node: no route to the database host
  "ENETUNREACH", // Node: no route to its network
  "ENOTFOUND", // Node: the host name doesn't resolve (yet)
  "EAI_AGAIN", // Node: DNS lookup failed for now
  "57P01", // Postgres: the server is shutting down
  "57P02", // Postgres: the server crashed and is restarting
  "57P03", // Postgres: the server is still starting up
  "53300", // Postgres: too many connections right now
  // SQLSTATE class 08, "connection exception", by name:
  "08000", // connection exception
  "08001", // the client couldn't establish the connection
  "08003", // the connection doesn't exist
  "08004", // the server refused the connection
  "08006", // connection failure
]);
// Not in the list on purpose, so they stay a 500:
//   57014  a query was cancelled (by statement_timeout): far more likely our slow SQL than an outage
//   08P01  protocol violation: a bug in the driver or in Postgres, not "the database is down"
//   08007  "did the commit happen? unknown". 503 means "try again", which could save it twice
// Every one of them must show up as a bug, never hide as an outage.

export function isDatabaseUnavailable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && UNAVAILABLE_CODES.has(code);
}
