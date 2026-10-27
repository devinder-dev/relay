# Relay: team context

Working agreements, architecture and decisions. Read this before working on the project.

## The project

**Relay makes sure messages between apps arrive, even when the receiving app is down.**
Webhook delivery as a service (like Svix or Hookdeck), built as the exam project for
Chas Academy's "Avancerad fullstackutveckling, test och DevOps".

- **Team:** Devinder Singh (backend + infrastructure) and Abdikhani Mohamed (frontend + quality).
  Every PR is reviewed by the other person. Both must be able to explain the whole system.
- **Dates:** Tenta 4 Wed 28 Oct · G target around Sat 31 Oct · **oral defense Wed 4 Nov
  (live demo)** · code submission Sun 8 Nov.
- **Strategy:** a **walking skeleton** first (a tiny API that the pipeline deploys to production,
  already with 2 pods and zero-downtime rollouts), then the features on top. All G requirements
  before VG. Quality and understanding come before speed: dates are targets, and on 4 Nov we show
  what is done and explain it well.

## How we work

- **Explain while building.** We are examined individually on every line, command and choice.
  Plain English, define each technical term the first time with a concrete example, and for
  every important choice name the main alternative and why we didn't pick it.
- **Plan before code.** For anything bigger than a small fix, agree on a short plan first.
- **One step at a time.** One step (a few commands, what they do, how to check), then check
  the result before the next one.
- **Just in time.** No scaffolding, packages, config or files before the current step needs them.
- **Verify, don't trust.** After a step, check it from outside where possible (read-only
  `ssh relay` / `kubectl get` / `gh api`), instead of relying on "done".
- **Commands that ask questions** (`adduser`, `passwd`, `ufw enable`, a first `sudo`) run
  alone, never inside a pasted block. Pasted lines get swallowed as answers (real incident, 22 Oct).
- **Docs over memory.** Check current official docs for Bun, Fastify, cert-manager, k3s and so on
  instead of guessing APIs.
- **By code, not by clicking.** Manifests, scripts, Terraform and `gh` wherever an API exists.
  Web panels only where none does (one.com VPS, get.tech DNS).
- **Decisions are written down** in `docs/decisions/` (one short record per choice).
- **Security scans.** Scan new security-sensitive code (auth, SQL, signing, webhooks, user input)
  with Snyk where available, and fix findings before the PR.

## Security rules

- Never share secrets in chat or commits: API keys, passwords, tokens, kubeconfig, `.env` files.
- Secrets live only in **GitHub Actions secrets** or **Kubernetes Secrets**. Never in git.
- The kubeconfig is an admin password. It stays on the server in `~/.kube/config`.
- Ask the other person before any destructive command on the VPS, the database or DNS.
- Never expose to the internet: Postgres (5432), the Kubernetes API (6443), `/metrics`
  (served on its own port 9090, which no Ingress points to).
- Endpoint URLs from customers must not point to internal, private or our own VPS addresses
  (SSRF). Checked when an endpoint is created **and** before every delivery attempt; redirects
  are never followed.

## How Relay works

1. A producer sends `POST /v1/events` with its API key (`Authorization: Bearer relay_live_…`).
2. The API validates it and, in **one transaction**, saves the event plus one **delivery** row
   per matching endpoint (exact event type, or an endpoint listening to `*`), then answers
   **202 Accepted**. A repeated `Idempotency-Key` returns the original answer.
3. Worker pods **claim** due deliveries with `FOR UPDATE SKIP LOCKED` and take a 60 s **lease**:
   `attempts + 1`, `next_attempt_at = now() + 60 s`, a fresh `lease_id`, commit. No transaction or
   connection is held during the HTTP call.
4. The worker checks the URL again (SSRF), signs with **Standard Webhooks** (headers
   `webhook-id` = event id, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256 of
   id.timestamp.body>`), and POSTs with a 10 s timeout. It signs again on **every** attempt.
5. 2xx = delivered. Error, redirect or timeout = retry with exponential backoff and ±20% jitter:
   5 s, 1 min, 5 min, 30 min, 2 h, 6 h, 12 h (8 tries, about 21 h). After the last try: **dead**,
   replayable. Tests and the demo use a shorter schedule from an environment variable.
6. The result is saved only `WHERE lease_id = <my lease>` (a **fencing token**). A crashed
   worker's lease runs out and the row becomes due again by itself.
7. At-least-once delivery: receivers drop duplicates by `webhook-id`.

**Data model v1** (Postgres 18.6, every id is a UUIDv7):
`owners` (id, name) · `api_keys` (owner_id, prefix, key_hash = SHA-256 UNIQUE, revoked_at) ·
`endpoints` (owner_id, name, url, signing_secret `whsec_…`, event_types[] default `{*}`,
disabled_at) · `events` (owner_id, type, payload jsonb object, idempotency_key; UNIQUE (owner_id,
idempotency_key)) · `deliveries` (owner_id, event_id, endpoint_id, status pending|delivered|dead,
attempts, next_attempt_at, lease_id, last_status_code, last_error, delivered_at; UNIQUE (event_id,
endpoint_id); partial INDEX (next_attempt_at) WHERE status = 'pending') · `attempts`
(delivery_id, started_at, duration_ms, status_code, error, response_excerpt).

**API v1:** `GET /v1/me` · `POST /v1/endpoints` (returns the signing secret once) ·
`GET /v1/endpoints` · `POST /v1/events` · `GET /v1/deliveries?status=&endpoint_id=&cursor=` ·
`GET /v1/deliveries/:id` · `POST /v1/deliveries/:id/replay` · `GET /health/live` (no DB check) ·
`GET /health/ready` (checks DB, 503 while shutting down) · `GET /version` (git SHA) ·
`/metrics` on port 9090 only. Errors: `{"error":{"code","message","request_id"}}`. Another
owner's id answers 404. Bodies: JSON only, max 256 KiB. CORS: `https://cdn.myrelay.tech` only.
Owners and API keys are created with a `create-owner` script (no signup page).
**The full contract, with every request and response shape, is in [`docs/api.md`](api.md).**
Both the API and the dashboard follow it; changes to it go through a PR first.

## Stack and decisions

| Area | Choice | Not chosen |
|---|---|---|
| Runtime | Bun **1.4.4**, pinned everywhere (laptop, CI, Docker). 1.4 is a new rewrite in Rust | Node (more common, but we know Bun; it stays our fallback) |
| Web framework | **Fastify 5** ([decision 0001](decisions/0001-web-framework-fastify.md)): `buildApp()` + `listen({ host: "0.0.0.0" })`, pino logs, Zod validation, `@fastify/cors`, `inject()` tests | Hono (native on Bun, but new to us), Express, Elysia |
| Database library | postgres.js behind one file `src/db.ts` | `Bun.sql` (ties the data layer to the new runtime), Drizzle |
| API code structure | **Zod 4** for bodies, queries and env vars ([decision 0003](decisions/0003-api-code-structure.md)); layers routes → services → repositories; one Fastify error handler with one error shape; small files, one job each | Fastify JSON Schema, `fastify-type-provider-zod`, logic in route handlers |
| Migrations | dbmate (plain SQL), run by a Kubernetes Job before each rollout. Expand/contract rule | drizzle-kit, an initContainer (would rerun on every scale-up) |
| Unit + integration tests | `bun test`; integration against a real Postgres (Docker locally, service container in GitHub Actions) | Testcontainers (no official Bun support), mocked DB |
| Dashboard | **Vite + React + TypeScript, Tailwind CSS v4, React Router, axios** (one client in `src/api.ts`), plain React state with a small refresh loop while a delivery is pending, served by nginx ([decision 0002](decisions/0002-dashboard-stack.md)) | Next.js, plain CSS, `fetch`, TanStack Query |
| E2E tests | Playwright, runs on Node in the dashboard folder | Cypress |
| Queue | Postgres `SKIP LOCKED` + lease with fencing token | RabbitMQ (stretch goal only, as a "doorbell"; dual-write problem) |
| Signing | Standard Webhooks, re-signed on every attempt | Our own header format |
| IDs | UUIDv7 (built into Postgres 18). Prefixes only on secrets: `relay_live_`, `whsec_` | bigint counters, prefixed ids |
| Database | `postgres:18.6` StatefulSet, volume mounted at `/var/lib/postgresql`, our own StorageClass `local-path-retain` (the default deletes data) | Neon / Supabase (brief: everything on our own VPS) |
| Orchestration | k3s v1.36.5 (Traefik, metrics-server, local-path, secrets encryption on) | Docker Compose |
| HTTPS | cert-manager v1.21.2 + Let's Encrypt, staging first; HTTP → HTTPS redirect in Traefik with `allowACMEByPass` | certbot by hand |
| Images | GHCR (public package), tag = git SHA | Docker Hub |
| CI/CD | GitHub Actions: test → build → push → deploy over SSH as a `deploy` user with a forced command (port 6443 stays closed), then check `/version` | Self-hosted runner, opening 6443, Argo CD |
| Observability | Slim kube-prometheus-stack + Loki + Alloy (Promtail is end-of-life); Grafana Cloud free tier as fallback | Datadog |
| Backups | Nightly CronJob: `pg_dump` → **Amazon S3** (eu-north-1), one timed restore | Volume snapshots, R2, B2 |
| IaC | Kubernetes YAML and scripts in git; **Terraform only for the S3 backup bucket** and its IAM user | Terraform for everything (no provider for one.com or get.tech; Helm via Terraform needs 6443) |
| Scaling / zero downtime | HPA on the API (2–4 pods, no `replicas:` field); workers fixed at 2; RollingUpdate maxUnavailable 0, readiness probe, preStop sleep, graceful SIGTERM | KEDA (stretch), blue-green |

**Left out on purpose:** rate limiting per IP (Traefik sees every client as `10.42.0.1`),
encrypting the signing-secret column (we protect the backups instead), OpenAPI tooling
(`docs/api.md` + shared types instead).

## Infrastructure facts

- **VPS:** one.com, Ubuntu 26.04, 4 vCPU / 8 GB / 200 GB, hostname `cloud-server-10692294`.
- **Access:** personal users `devinder` and `abdikhani`, SSH keys only, no root login.
  Log in with `ssh relay` (alias in each person's `~/.ssh/config`). `administrator` is
  one.com's default account, kept as a backup.
- **Firewalls:** one.com's network firewall + ufw. ufw allows 22, 80, 443 and the k3s networks
  10.42.0.0/16 and 10.43.0.0/16. one.com's firewall allows 22, 80 and 443.
- **kubectl:** only on the server (`ssh relay`, then `kubectl …`). Port 6443 stays closed.
- **Deploy path:** GitHub Actions (environment `production`, main only) logs in as the Linux
  user `deploy`, whose key can only start `/usr/local/bin/relay-deploy`. The script deploys a
  commit only if it is on main, using the Kubernetes account `deployer` (namespace `relay`
  only, no Secrets). Which folder is applied how: [`k8s/README.md`](../k8s/README.md).
- **Domain:** `myrelay.tech`, DNS at get.tech. A records for `api`, `cdn` (the Relay dashboard)
  and `grafana` (the ops dashboard: metrics and logs) all point to the VPS. **No AAAA records**:
  the cluster is IPv4-only, and Let's Encrypt prefers IPv6 when it exists.
- **HTTP → HTTPS:** `k8s/platform/traefik-config.yaml` (a HelmChartConfig) redirects port 80 to
  443 for every host with a 308, except `/.well-known/acme-challenge/`, so certificate checks still
  work over plain HTTP.

## Git workflow

- `main` is protected: changes only through a PR with 1 approval from the other person,
  no force-pushes, no deletion. Once the pipeline exists, it must pass too.
- Branch names: `feat/…`, `fix/…`, `docs/…`, `infra/…`, `test/…`.
- Commit messages: `type: short summary` (for example `docs: add team context`).
- Small PRs, squash-merge, delete the branch after merging.
- Only commit and push when the person doing the work says so.

## Where we are

Phase 0 (server foundation) is done: VPS hardened, k3s, cert-manager with Let's Encrypt
issuers, and a temporary hello-world app on https://api.myrelay.tech with a trusted
certificate.

Phase 1 (walking skeleton) is well under way. Done: HTTP → HTTPS redirect (1.1), DNS for cdn
and grafana (1.2), the API skeleton in `api/` with its Docker image (1.3–1.4, PR #11), the CI
pipeline that tests every PR and pushes the image from main (1.5, PR #12), and the deploy path
(1.6): a `deploy` user whose key can only run `relay-deploy`, and a `deployer` account limited
to namespace `relay`. Next: 1.7, the API manifests in `k8s/app/`, then 1.8, the first deploy
through the pipeline.

The plan in order: 1 walking skeleton · 2 database foundation · 3 core API · 4 worker ·
5 dashboard on cdn (Abdikhani, in parallel) · 6 backups + Terraform (Abdikhani, in parallel) ·
7 metrics and logs (Abdikhani, in parallel) · 8 VG under load · 9 docs and defense · 10 submit.
