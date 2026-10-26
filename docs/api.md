# Relay API v1: the contract

This file is the **single source of truth** for what the API accepts and returns. The API
(`api/`) and the dashboard (`dashboard/src/types.ts`) both follow it. To change it, open a PR
that changes this file, approved by both of us, before or together with the code.

## Conventions

| Topic | Rule |
|---|---|
| Base URL | `https://api.myrelay.tech` |
| Auth | Every `/v1` route needs `Authorization: Bearer relay_live_<key>`. `/health/*` and `/version` need none |
| Format | JSON only (`Content-Type: application/json`), request bodies up to 256 KiB |
| Field names | `snake_case` |
| IDs | UUIDv7 strings, e.g. `0199a3b2-7c41-7d2e-9f10-3b5c8e1a2d47` |
| Times | ISO 8601 in UTC, e.g. `2026-10-25T14:03:21.512Z` |
| Request id | Every response has an `X-Request-Id` header, the same id as in our logs and in error bodies |
| Other owners' data | Answered with **404**, never 403, so nobody can probe which ids exist |
| CORS | Browsers may call the API only from `https://cdn.myrelay.tech` (and localhost in CI) |

### Errors

Every error has the same shape:

```json
{ "error": { "code": "not_found", "message": "Delivery not found", "request_id": "…" } }
```

A 422 also has `details`, one entry per problem:

```json
{ "error": { "code": "validation_failed", "message": "Request validation failed", "request_id": "…",
             "details": [ { "path": "payload", "message": "Invalid input: expected record, received string" } ] } }
```

| Status | `code` | When |
|---|---|---|
| 400 | `bad_request` | Broken JSON, bad query string |
| 401 | `unauthorized` | Missing, unknown or revoked API key |
| 404 | `not_found` | Unknown route, or an id that doesn't exist or isn't yours |
| 409 | `already_delivered` | Replay of a delivery that is already delivered |
| 409 | `in_flight` | Replay of a delivery a worker is sending right now |
| 413 | `payload_too_large` | Body over 256 KiB |
| 415 | `unsupported_media_type` | Body that isn't JSON |
| 422 | `validation_failed` | Body or query fails the rules below (`details` lists why) |
| 422 | `invalid_endpoint_url` | Endpoint URL that isn't `https`, or points to a private or internal address |
| 500 | `internal_error` | Our bug. The message never contains internal details |

### Pagination

Lists that can grow use a **cursor**: `?limit=50&cursor=<id>` → `{ "data": [...], "next_cursor": "<id>" | null }`.
Pass `next_cursor` as `cursor` to get the next page. `null` means there are no more pages.
Newest first. `limit` is 1–100, default 50.

## Types

The dashboard can copy these into `src/types.ts`. The API's responses must match them.

```ts
export type DeliveryStatus = "pending" | "delivered" | "dead";
export type EndpointStatus = "active" | "failing" | "disabled";
export type AttemptError = "timeout" | "connect_failed" | "blocked_address" | "redirect" | "tls";

export interface Owner { id: string; name: string }

// GET /v1/me
export interface Me {
  owner: Owner;
  key: { prefix: string };              // e.g. "relay_live_8f2k", safe to show
}

export interface Endpoint {
  id: string;
  name: string;
  url: string;
  event_types: string[];                // ["*"] means every event type
  status: EndpointStatus;               // worked out when read, see below
  created_at: string;
}

// Only in the answer to POST /v1/endpoints: the secret is shown once, never again.
export interface EndpointCreated extends Endpoint {
  signing_secret: string;               // "whsec_…"
}

// One row in GET /v1/deliveries
export interface Delivery {
  id: string;
  status: DeliveryStatus;
  attempts: number;                     // tries in the current cycle (the retry budget); replay resets it to 0
  next_attempt_at: string | null;       // when the next try is due; null unless status is "pending"
  last_status_code: number | null;      // HTTP status of the last try; null if the receiver never answered
  last_error: AttemptError | null;      // why the last try failed without a status code; null otherwise
  delivered_at: string | null;          // set only when status is "delivered"
  created_at: string;
  event: { id: string; type: string };
  endpoint: { id: string; name: string };
}

// One try at a delivery
export interface Attempt {
  id: string;
  number: number;                       // 1, 2, 3 … across the whole history, including after replays
  started_at: string;
  duration_ms: number;
  status_code: number | null;           // null = no HTTP answer (see error)
  error: AttemptError | null;           // null when the receiver answered (even with 500)
  response_excerpt: string | null;      // first 1 KB of the receiver's answer
}

// GET /v1/deliveries/:id
export interface DeliveryDetail extends Omit<Delivery, "event" | "endpoint"> {
  event: { id: string; type: string; payload: Record<string, unknown>; created_at: string };
  endpoint: { id: string; name: string; url: string };
  attempt_log: Attempt[];               // the full history, oldest first, never deleted
}

// POST /v1/events
export interface EventAccepted {
  id: string;
  type: string;
  created_at: string;
  deliveries: number;                   // how many endpoints will receive it
}

export interface Page<T> { data: T[]; next_cursor: string | null }

export interface ApiError {
  error: {
    code: string;
    message: string;
    request_id: string;
    details?: { path: string; message: string }[];
  };
}
```

**`attempts` vs `attempt_log`:** `attempts` is a **number**, the retry budget for the current cycle.
It drives the backoff schedule and goes back to 0 on replay. `attempt_log` is the **history**: every try
ever made, numbered, never deleted. After a replay of a dead delivery, `attempts` is 0 and
`attempt_log` still has its 8 old rows; the next try becomes number 9.

**Endpoint `status`** is worked out when the list is read, from the endpoint's latest delivery:
`disabled` if the endpoint is disabled, `failing` if its latest delivery is `dead` or is `pending`
after a failed try, otherwise `active`.

## Routes

### Health (no auth)

| Route | Answer |
|---|---|
| `GET /health/live` | 200 `{ "status": "ok" }`. Never checks the database |
| `GET /health/ready` | 200 `{ "status": "ok" }`, or 503 while shutting down or when the database is unreachable |
| `GET /version` | 200 `{ "sha": "<git commit>" }` |

### `GET /v1/me`

200 → `Me`. Used by the dashboard's Connect screen to check a key. Errors: 401.

### `POST /v1/endpoints`

Body:

| Field | Rule |
|---|---|
| `name` | string, 1–100 characters |
| `url` | `https` URL, at most 2048 characters, must resolve only to public addresses |
| `event_types` | optional, 1–20 strings, each an exact event type or `"*"`; default `["*"]` |

201 → `EndpointCreated` (with `signing_secret`, shown only here). Errors: 401, 422 `validation_failed`, 422 `invalid_endpoint_url`.

### `GET /v1/endpoints`

200 → `{ "data": Endpoint[] }`. At most 20 endpoints per owner, so no paging. Errors: 401.

### `POST /v1/events`

Header (optional): `Idempotency-Key: <up to 255 characters>`.

Body:

| Field | Rule |
|---|---|
| `type` | matches `^[a-z0-9][a-z0-9_.-]{0,99}$`, e.g. `invoice.paid` |
| `payload` | a JSON object |

202 → `EventAccepted`. The event and one delivery per matching endpoint are saved in one transaction;
a matching endpoint lists this exact type or `"*"`. Sending the same `Idempotency-Key` again returns the
first answer again, with the header `Idempotent-Replayed: true`, and creates nothing new.
Errors: 401, 413, 415, 422.

### `GET /v1/deliveries`

Query: `status` (optional, a `DeliveryStatus`), `endpoint_id` (optional), `limit`, `cursor`.

200 → `Page<Delivery>`, newest first. Errors: 400, 401, 422.

### `GET /v1/deliveries/:id`

200 → `DeliveryDetail`. Errors: 401, 404.

### `POST /v1/deliveries/:id/replay`

Allowed when the delivery is `dead`, or `pending` and not being sent right now ("retry now").

202 → `Delivery` as it is after the replay: `status: "pending"`, `attempts: 0`,
`next_attempt_at` ≈ now, `last_error: null`. The dashboard then reloads the detail screen.
Errors: 401, 404, 409 `already_delivered`, 409 `in_flight`.

## Example: one row of `GET /v1/deliveries`

```json
{
  "id": "0199a3b2-7c41-7d2e-9f10-3b5c8e1a2d47",
  "status": "pending",
  "attempts": 3,
  "next_attempt_at": "2026-10-25T14:09:30.000Z",
  "last_status_code": 500,
  "last_error": null,
  "delivered_at": null,
  "created_at": "2026-10-25T14:03:20.000Z",
  "event": { "id": "0199a3b2-7b10-7a01-8c22-1f4d6e9b0c11", "type": "invoice.paid" },
  "endpoint": { "id": "0199a1f0-2e3d-7b44-a1c9-55d0e2f7a6b3", "name": "Accounting webhook" }
}
```

## Not in v1 (later)

`DELETE /v1/endpoints/:id`, per-owner stats, signing-secret rotation, a circuit breaker per endpoint.
