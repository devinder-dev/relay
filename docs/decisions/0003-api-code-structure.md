# 0003. API code structure: Zod, layers and one error handler

- **Status:** Accepted
- **Date:** 2026-10-25
- **Decided by:** Devinder Singh and Abdikhani Mohamed

## Context

The API and the worker will grow to around ten routes, a queue and several database tables.
We are examined individually on every line, so the code must be easy to read, explain and test.
We want small files with one job each, no surprises, and a clear answer to "where does this
logic live?".

## Decision

### Validation with Zod

Every request body, query string and the environment variables are checked with **Zod 4**.
One Zod schema gives both the runtime check and the TypeScript type (`z.infer`), so nothing is
described twice.

```ts
const body = CreateEventBody.parse(request.body); // a wrong body throws, the error handler answers 422
```

We call `parse()` ourselves in the route. No plugin.

| Not chosen | Why |
|---|---|
| Fastify's JSON Schema validation | The type must be written a second time by hand, or generated with more tooling |
| `fastify-type-provider-zod` | Hides the parse call, and requires `@fastify/swagger` and `openapi-types` as extra packages |

### Layers, one direction only

```
routes/        HTTP only: check input with Zod, call a service, send the answer
   ▼
services/      the rules: fan-out, idempotency, replay, transactions
   ▼
repositories/  SQL only: one file per table group, returns typed rows
   ▼
Postgres
```

- A layer only calls the layer below it. Nobody skips a layer.
- Repositories take the database handle as their first argument (`db`), so one service can
  run several repositories inside **one transaction** (`sql.begin(tx => …)`).
- Pure logic (retry timing, signing, the SSRF address check) lives in small files with no
  database or HTTP, so it can be unit-tested directly.

### One error handler

Code never builds error responses itself. It throws, and **one** Fastify error handler
(`error-handler.ts`) turns every error into the same shape:
`{"error": {"code", "message", "request_id"}}`.

| Error | Answer |
|---|---|
| `ZodError` | 422 `validation_failed`, with the fields that were wrong |
| Our own `AppError` (for example `notFound`, `conflict`) | Its own status and code (404 `not_found`, 409 `already_delivered`, …) |
| Fastify's own client errors | Their status: 400 bad JSON, 413 body too large, 415 not JSON |
| Anything else | Logged in full, answered as 500 `internal_error` with no details |

### Files

```
api/src/
├─ server.ts          start and graceful shutdown (the only file that listens on a port)
├─ app.ts             buildApp(): plugins, error handler and routes wired together
├─ config.ts          environment variables, checked with Zod at startup
├─ errors.ts          AppError and helpers (notFound, conflict)
├─ error-handler.ts   the one place errors become HTTP answers
├─ db.ts              the Postgres connection
├─ schemas/           Zod schemas and their types
├─ routes/            one file per resource
├─ services/          one file per resource
└─ repositories/      one file per table group
```

Files stay small: roughly under 150 lines, one job each. Folders are created only when a step
needs them.

## Consequences

- **Testing:** pure functions get unit tests; repositories get integration tests against a real
  Postgres; routes get `inject()` tests that go through the real error handler.
- **Bad configuration fails fast:** a missing or wrong environment variable stops the app at
  startup with a clear message, before Kubernetes marks the pod as ready.
- **No leaks:** a database error can never reach a client with its SQL or stack trace, because
  only the error handler writes error responses.
- [Decision 0001](0001-web-framework-fastify.md) refers here for validation: we use Zod instead of
  Fastify's built-in JSON Schema.
