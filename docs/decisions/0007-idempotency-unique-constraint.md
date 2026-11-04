# 0007. Idempotent events: a unique constraint, read under READ COMMITTED

- **Status:** Accepted
- **Date:** 2026-11-04
- **Decided by:** Devinder Singh and Abdikhani Mohamed

## Context

`POST /v1/events` takes an optional `Idempotency-Key`. A producer that doesn't know whether its
first request was saved (a 503, a dropped connection, a 500) sends it again with the same key,
and must get the first answer back without a second event. Two copies of the same request can
also arrive at the same moment, on different pods.

## Decision

- **The database decides, not our code.** `events` has `UNIQUE (owner_id, idempotency_key)`.
  The insert is `INSERT … ON CONFLICT (owner_id, idempotency_key) DO NOTHING RETURNING …`, inside
  the same transaction as the fan-out to `deliveries`.
- **A replay is read by a separate statement.** When the insert returns no row, the key already
  exists, and a second statement reads that event and its delivery count. A second request with
  the same key waits at the unique index until the first commits; under **READ COMMITTED**
  (Postgres's default) the next statement gets a fresh view and sees the first request's row.
- **The key wins.** The same key with a different body returns the first answer and saves
  nothing new (written in `docs/api.md`). Refusing it, as Stripe and Svix do, would need a new
  error code in the contract; that can come later.

| Not chosen | Why not |
|---|---|
| Look the key up first, insert if missing | Two requests both look, both find nothing, both insert: a check-then-act race |
| An advisory lock on a hash of the key | Works, but adds a lock we have to explain, and the unique constraint is still needed as the real guarantee |
| `SERIALIZABLE` and retry on `40001` | Correct, but every caller needs retry code for something the constraint already solves |
| Redis `SETNX` | A second system that has to agree with Postgres: the dual-write problem |

## Consequences

- **READ COMMITTED is load-bearing.** Under REPEATABLE READ the replay `SELECT` would use the
  transaction's first snapshot, and a request that waited for a concurrent one with the same key
  would not see it: a 500 instead of the first answer. Checked on 4 Nov: with
  `sql.begin("isolation level repeatable read", …)` the race test (five requests with one key,
  held at a real lock) goes red, while the one-after-another retry tests stay green. So don't
  raise the isolation level for this transaction; the race test is what would catch it.
- A key is per owner: the same key from two owners gives two events.
- Requests without a key never conflict (NULLs are never equal in a UNIQUE constraint), so a
  retry without a key can create a second event. `docs/api.md` tells producers to send a key.
