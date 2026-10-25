# 0001. Web framework: Fastify

- **Status:** Accepted
- **Date:** 2026-10-25
- **Decided by:** Devinder Singh and Abdikhani Mohamed

## Context

The Relay API needs an HTTP framework. Our runtime is **Bun 1.4.4**, pinned because Bun 1.4 is the
first release of Bun rewritten in Rust (August 2026). The API must:

- route requests and read path parameters (`/v1/deliveries/:id`);
- validate JSON bodies (`POST /v1/events`);
- write JSON logs with a request id on every line;
- limit body size (256 KiB) and allow CORS from `https://cdn.myrelay.tech`;
- shut down gracefully on SIGTERM, which is needed for zero-downtime rollouts;
- be testable without starting a server.

Both of us are examined individually and must be able to explain every line.

## Options considered

| Option | For | Against |
|---|---|---|
| **Fastify 5** | Both of us have used it. JSON logging (pino) with request ids, body validation (JSON Schema), body limit and request ids are built in. `inject()` tests without a server. Runs on Node unchanged. | Built for Node's `http` module, so on Bun it runs through Bun's Node-compatibility layer, which Bun 1.4 rewrote. Not tested by us on 1.4.4 yet. Listens on `localhost` by default. More concepts (plugins, encapsulation, hooks). |
| Hono 4 | Runs on Bun's native server (`Bun.serve`). Web-standard Request/Response. CORS, body limit and request id built in. `app.request()` tests. | New for both of us. Logging and validation must be added (own logger, Zod). |
| Express | Most widely known. | Older design without web-standard Request/Response; needs extra packages for the features above. |
| Elysia | Fast, Bun-first. | Runs only on Bun; more "magic" that is harder to explain. |

## Decision

We use **Fastify 5** on Bun 1.4.4.

Familiarity was the deciding factor: we can write, review and explain Fastify code with
confidence. Its built-in pino logging (with a request id on every line) also covers a need we
would otherwise build ourselves.

## Consequences

- **Extra check in step 1.3:** before building on it, we run the app and its tests on Bun 1.4.4 and
  put it under some load, to confirm Bun's Node-compatibility layer behaves.
- **Fallback:** if Bun causes problems, the same Fastify code runs on Node without changes.
- **Listen address:** the server must listen with `host: "0.0.0.0"`, because the default
  (`localhost`) can't be reached from outside a container.
- **App structure:** `buildApp()` creates the app (one fresh instance per test, used with `inject()`);
  `server.ts` only calls `listen()` and handles SIGTERM with `app.close()`.
- **Logging:** pino, built into Fastify, writing JSON to stdout. We keep our agreed field names
  (`request_id`, `event_id`, `delivery_id`, `endpoint_id`, `status_code`, `duration_ms`).
- **Validation:** Zod, called in each route ([decision 0003](0003-api-code-structure.md)). We don't
  use Fastify's built-in JSON Schema validation: with Zod each body is described once and gives
  both the runtime check and the TypeScript type.
- **CORS:** the `@fastify/cors` plugin, limited to `https://cdn.myrelay.tech` (and localhost in CI).
