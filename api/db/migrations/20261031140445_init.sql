-- migrate:up
-- Migration 001: schema v1 (step 2.4). Run by dbmate in the migrate Job before every rollout.
-- Rules for every migration (docs/decisions/0006-migrations-expand-contract.md):
--   only ADD things old code can live with; never edit a merged migration; fix forward.
--
-- Every id is a UUIDv7 (built into Postgres 18): unique, ordered by time (so it also works as
-- the page cursor), and impossible to guess. Statuses are text + CHECK, not an enum: adding an
-- allowed value later is a small change, removing one from an enum is not.

-- Give up after 5 s of WAITING for a lock instead of queueing every API query behind us.
-- (An empty database has no locks to wait for; every migration starts the same way.)
SET LOCAL lock_timeout = '5s';

-- A customer of Relay.
CREATE TABLE owners (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- An owner's API keys. Only a SHA-256 hash of the key is stored: a stolen database (or backup)
-- doesn't contain usable keys. Lookup is by hash, so no secret is ever compared character by
-- character. No "last used" column: updating it on every request would make this a hot row.
CREATE TABLE api_keys (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  owner_id   uuid NOT NULL REFERENCES owners ON DELETE CASCADE,
  prefix     text NOT NULL,                  -- e.g. 'relay_live_8f2k', safe to show in the dashboard
  key_hash   bytea NOT NULL UNIQUE,          -- sha256(the full key)
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

-- Where an owner wants events delivered. Deleting one is a soft delete (deleted_at), so old
-- deliveries keep showing its name and URL (docs/api.md, DELETE /v1/endpoints/:id).
-- The signing secret is stored in plain text on purpose: signing with HMAC needs the secret
-- itself, so it can't be hashed like an API key. Backups are protected instead (Phase 6).
CREATE TABLE endpoints (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  owner_id       uuid NOT NULL REFERENCES owners ON DELETE CASCADE,
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  url            text NOT NULL CHECK (length(url) <= 2048),
  signing_secret text NOT NULL,              -- 'whsec_' + base64(32 random bytes)
  event_types    text[] NOT NULL DEFAULT '{*}' CHECK (cardinality(event_types) BETWEEN 1 AND 20),
  deleted_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- An owner's endpoints that aren't deleted (the fan-out and the endpoint list read these).
CREATE INDEX endpoints_owner_live ON endpoints (owner_id) WHERE deleted_at IS NULL;

-- An event a producer sent (POST /v1/events). The same Idempotency-Key from the same owner
-- can't be stored twice; events without a key (NULL) never collide, because NULLs are never
-- equal in a UNIQUE constraint.
CREATE TABLE events (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  owner_id        uuid NOT NULL REFERENCES owners ON DELETE CASCADE,
  type            text NOT NULL CHECK (type ~ '^[a-z0-9][a-z0-9_.-]{0,99}$'),
  payload         jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  idempotency_key text CHECK (length(idempotency_key) <= 255),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT events_owner_idempotency_key UNIQUE (owner_id, idempotency_key)
);

-- One event to one endpoint: the queue. Workers claim due rows with FOR UPDATE SKIP LOCKED and
-- a lease (Phase 4). While a row is leased, next_attempt_at is the lease's expiry and lease_id
-- is the fencing token: a result is only saved by the worker that still holds the lease.
CREATE TABLE deliveries (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  owner_id         uuid NOT NULL REFERENCES owners ON DELETE CASCADE,
  event_id         uuid NOT NULL REFERENCES events ON DELETE CASCADE,
  endpoint_id      uuid NOT NULL REFERENCES endpoints ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
  attempts         int NOT NULL DEFAULT 0,   -- tries in the current cycle (replay resets it)
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  lease_id         uuid,
  last_status_code int,
  last_error       text,
  delivered_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deliveries_event_endpoint UNIQUE (event_id, endpoint_id)
);
-- The worker's claim query: "pending rows that are due, oldest first". Partial: only pending
-- rows are in it, so it stays small while delivered and dead rows pile up.
CREATE INDEX deliveries_due ON deliveries (next_attempt_at) WHERE status = 'pending';
-- The delivery list (newest first, keyset paging on id), with and without the filters.
CREATE INDEX deliveries_owner_id ON deliveries (owner_id, id DESC);
CREATE INDEX deliveries_owner_status_id ON deliveries (owner_id, status, id DESC);
CREATE INDEX deliveries_endpoint_id ON deliveries (endpoint_id, id DESC);

-- Every try at a delivery, kept forever (the dashboard's attempt timeline). The attempt number
-- is worked out when read (row_number()), so no counter has to be kept in step.
CREATE TABLE attempts (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  delivery_id      uuid NOT NULL REFERENCES deliveries ON DELETE CASCADE,
  started_at       timestamptz NOT NULL,
  duration_ms      int NOT NULL,
  status_code      int,
  error            text,                     -- timeout | connect_failed | blocked_address | redirect | tls
  response_excerpt text                      -- the first 1 KB of the receiver's answer
);
CREATE INDEX attempts_delivery_id ON attempts (delivery_id, id);

-- migrate:down
-- Forward-only, on purpose (ADR 0006). "dbmate rollback" would run this section and then delete
-- this migration's row in schema_migrations; an empty section would leave every table in place
-- while marking it "not applied". Raising an error rolls the whole rollback back instead.
-- To start over on a laptop, throw the throwaway database away.
DO $$ BEGIN RAISE EXCEPTION 'forward-only: migrations are never rolled back; to reset, recreate the throwaway database'; END $$;
