# 0006. Database migrations: forward-only, expand/contract

- **Status:** Proposed
- **Date:** 2026-10-31
- **Decided by:** Devinder Singh and Abdikhani Mohamed

## Context

Every deploy changes the database before the new pods start: `relay-deploy` creates a migrate
Job (`k8s/migrate/job.yaml`) that runs `dbmate migrate` from the commit's own image, and only
then applies `k8s/app/`. Two moments make that dangerous:

1. **During a rollout**, old and new pods serve requests at the same time, against the same
   tables (`maxSurge: 1`, `maxUnavailable: 0`).
2. **After a failed deploy**, `relay-deploy` brings back the last good commit's **code**, but the
   database keeps its **new** shape. dbmate never runs migrations backwards.

So a migration that breaks the old code breaks production twice: during every rollout, and again
exactly when the rollback is needed. Code can't protect against that. A rule that every migration
follows can, and it has to be written down so each migration can be checked against it in review.

## Options considered

| Option | For | Against |
|---|---|---|
| **Forward-only + expand/contract** (chosen) | Old and new code always work on the schema that's there; a rollback is just a redeploy | A rename or a removal takes several small releases |
| `down` migrations, run on rollback | One release per change | Runs untested SQL backwards in production; old code would still meet data written by new code; a `down` that drops a column destroys data |
| Two databases, switched over (blue-green) | Clean cut-over | Two Postgres kept in sync on one VPS: far more than this project needs |
| Care, without a written rule | No process | Relies on remembering, under time pressure |

## Decision

Migrations are **forward-only**, and every migration follows these rules:

1. **Every migration works with the code that runs now *and* the code being deployed.** Both run
   during a rollout, and after a rollback the old code runs on the new schema.
2. **Expand first:** add tables, nullable columns, columns with a default, new indexes. A new
   constraint can be added as `NOT VALID` and validated later, but `NOT VALID` only skips the
   *existing* rows: every new write is checked at once, so the rule must also accept what the
   *previous* release writes.
3. **Contract later, in a separate deploy:** remove something only when the **last good release**
   (the one `relay-deploy` would roll back to) no longer reads or writes it.
4. **Never in one deploy:** rename a column or table, change a column's type, drop something still
   used, or add `NOT NULL` to a filled column without a default.
5. **Transactional migrations start with `SET LOCAL lock_timeout = '5s';`.** An `ALTER TABLE`
   waits for its lock, and while it waits every new query queues behind it; giving up after 5 s
   of *waiting* is better than freezing the API. It limits only the wait, not how long a statement
   then holds the lock (a normal `CREATE INDEX` on a big table gets its lock at once and blocks
   writes until it's done). So a change to a table that already has data says in its PR how long
   it takes and what it locks, tried on a copy.
6. **Data backfills don't go in a migration.** They run separately, in batches, and their
   completeness is checked before the next release relies on them.
7. **A merged migration is never edited.** dbmate won't run it again, so the edit would exist
   only in git. Mistakes are fixed forward, with a new file.
8. **Rollback never runs `down`.** Every `-- migrate:down` section raises an error on purpose, so
   an accidental `dbmate rollback` can't delete a migration's row in `schema_migrations` while
   its tables stay (which would make the next `migrate` crash).
9. **No `-- migrate:up transaction:false` without a reason in the PR** (for example
   `CREATE INDEX CONCURRENTLY`). Outside a transaction a failure can leave half a change: a
   concurrent index can be left `INVALID` and must be dropped before retrying. `SET LOCAL` does
   nothing there, so such a file sets `SET lock_timeout` for its session and resets it at the end.

### Example: renaming `endpoints.name` to `label`

| Release | Migration (runs first) | The code reads / writes | A rollback lands on | Safe because |
|---|---|---|---|---|
| R1 | Add `label`, nullable | Writes **both** columns, reads `name` | R0 (knows only `name`) | R0 ignores `label`, and `name` is still written |
| (backfill) | – | A batch job copies `name` → `label` for old rows, then checks that none is NULL | – | – |
| R2 | – | Writes both, reads **`label`** | R1 (reads `name`) | Both columns are still written, so either reader is right |
| R3 | Drop `NOT NULL` from `name`, if it has it | Writes and reads **only `label`** | R2 (reads `label`) | R2 reads `label`, which R3 keeps writing |
| R4 | **Drop `name`** (allowed: the last good release is R3, which never touches it) | Unchanged | R3 | R3 doesn't use `name` |

R3 can't come straight after R1: a rollback from R3 would land on R1, which reads `name`, and the
rows R3 wrote have no `name`. Four releases look slow, but each one is small, and at no point does
a deploy or a rollback break.

## Consequences

- **Migration 001** creates every table in an empty database, so it needs no compatibility care.
  It already follows the rules: it starts with `SET LOCAL lock_timeout`, and its `down` raises an
  error.
- **Reviewing a PR that adds a migration** includes one question: "Is this expand-only, and does
  the last good release still work with it?"
- **A failed migration** is undone by Postgres (each file runs in one transaction), the deploy
  stops before any pod changes, and `relay-deploy` redeploys the last good commit. If two files
  were pending and the second failed, the first stays applied, which is fine because each one is
  expand-only on its own.
- **Resetting a database** on a laptop means throwing the throwaway container away, not running
  `down`.
- **Possible later:** a CI check that refuses changes to merged migration files (rule 7).
