// Extends only the child fixture's statement timeout so a lock can exercise the drain deadline.
import { mock } from "bun:test";
import { createDb, waitForDatabase, pingDatabase, isDatabaseUnavailable } from "../../src/db.ts";

const originalCreateDb = createDb;
// Step 1: production keeps its five-second statements; this child must wait beyond twenty.
mock.module("../../src/db.ts", () => ({
  createDb: (config: Parameters<typeof createDb>[0]) => {
    const db = originalCreateDb(config);
    db.options.connection.statement_timeout = 60_000;
    return db;
  }, waitForDatabase, pingDatabase, isDatabaseUnavailable,
}));
