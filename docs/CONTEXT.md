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
- Never expose to the internet: Postgres (5432), the Kubernetes API (6443), Grafana (SSH tunnel
  only). `/metrics` is not built yet; if it is, it gets its own port that no Ingress points to.
- Endpoint URLs from customers must not point to internal, private or our own VPS addresses
  (SSRF). Checked when an endpoint is created **and** before every delivery attempt; redirects
  are never followed. **Known gap, closed in Phase 4: DNS rebinding.** A name can resolve to a
  public address at the check and to a private one when the request is sent, so a second check
  only narrows the window. The worker closes it by connecting only to the address it just
  checked (Host and SNI kept), behind a NetworkPolicy. Nothing is sent before Phase 4.

## How Relay works

1. A producer sends `POST /v1/events` with its API key (`Authorization: Bearer relay_live_…`).
2. The API validates it and, in **one transaction**, saves the event plus one **delivery** row
   per matching endpoint (exact event type, or an endpoint listening to `*`), then answers
   **202 Accepted**. A repeated `Idempotency-Key` returns the original answer
   ([decision 0007](decisions/0007-idempotency-unique-constraint.md)).
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
deleted_at = soft delete) · `events` (owner_id, type, payload jsonb object, idempotency_key; UNIQUE (owner_id,
idempotency_key)) · `deliveries` (owner_id, event_id, endpoint_id, status pending|delivered|dead,
attempts, next_attempt_at, lease_id, last_status_code, last_error, delivered_at; UNIQUE (event_id,
endpoint_id); partial INDEX (next_attempt_at) WHERE status = 'pending') · `attempts`
(delivery_id, started_at, duration_ms, status_code, error, response_excerpt).

**API v1:** `GET /v1/me` · `POST /v1/endpoints` (returns the signing secret once) ·
`GET /v1/endpoints` · `DELETE /v1/endpoints/:id` (soft delete) · `POST /v1/events` · `GET /v1/deliveries?status=&endpoint_id=&cursor=` ·
`GET /v1/deliveries/:id` · `POST /v1/deliveries/:id/replay` · `GET /health/live` (no DB check) ·
`GET /health/ready` (never checks the DB; 503 while shutting down) · `GET /version` (git SHA) ·
`/metrics` is **not implemented** (it was planned for port 9090 only, which no Ingress would point to). Errors: `{"error":{"code","message","request_id"}}`. Another
owner's id answers 404. Bodies: JSON only, max 256 KiB. CORS: `https://cdn.myrelay.tech`, and `http://localhost:4173` (Playwright's preview server), as in `docs/api.md`.
Owners and API keys are created with a `create-owner` script (no signup page).
**The full contract, with every request and response shape, is in [`docs/api.md`](api.md).**
Both the API and the dashboard follow it; changes to it go through a PR first.

## Stack and decisions

| Area | Choice | Not chosen |
|---|---|---|
| Runtime | **API and worker:** Bun **1.4.4**, pinned on the laptops, in CI and in Docker (1.4 is a new rewrite in Rust). **Dashboard build and e2e:** Node **24.22.1** ([decision 0005](decisions/0005-dashboard-toolchain.md)) | *For the API:* Node (more common, but we know Bun; it stays our fallback). *For the dashboard:* Bun (Vite and Playwright are built for and released against Node) |
| Web framework | **Fastify 5** ([decision 0001](decisions/0001-web-framework-fastify.md)): `buildApp()` + `listen({ host: "0.0.0.0" })`, pino logs, Zod validation, `@fastify/cors`, `inject()` tests | Hono (native on Bun, but new to us), Express, Elysia |
| Database library | postgres.js 3.4.9 behind one file `src/db.ts`: pool 5 per pod, 5 s `statement_timeout`; the API waits for the database before it listens, and answers 503 `service_unavailable` while it can't reach it | `Bun.sql` (ties the data layer to the new runtime), Drizzle |
| API code structure | **Zod 4** for bodies, queries and env vars ([decision 0003](decisions/0003-api-code-structure.md)); layers routes → services → repositories; one Fastify error handler with one error shape; small files, one job each | Fastify JSON Schema, `fastify-type-provider-zod`, logic in route handlers |
| Migrations | dbmate (plain SQL, `api/db/migrations/`, inside the API image), run by the migrate Job (`k8s/migrate/`) that `relay-deploy` creates before each rollout. Forward-only, expand/contract ([decision 0006](decisions/0006-migrations-expand-contract.md)) | drizzle-kit, an initContainer (would rerun on every scale-up), `down` migrations on rollback |
| Unit + integration tests | `bun test`; integration tests against a real Postgres, logged in as `relay`: the same throwaway container (production's image and first-start script) on the laptop and in GitHub Actions (`bun run db:up`, then `bun run test:db`) | Testcontainers (no official Bun support), mocked DB |
| Dashboard | **Vite + React + TypeScript, Tailwind CSS v4, React Router, axios** (one client in `src/api.ts`), plain React state with a small refresh loop while a delivery is pending, served by nginx ([decision 0002](decisions/0002-dashboard-stack.md)) | Next.js, plain CSS, `fetch`, TanStack Query |
| E2E tests | Playwright, runs on Node in the dashboard folder | Cypress |
| Queue | Postgres `SKIP LOCKED` + lease with fencing token | RabbitMQ (stretch goal only, as a "doorbell"; dual-write problem) |
| Signing | Standard Webhooks, re-signed on every attempt | Our own header format |
| IDs | UUIDv7 (built into Postgres 18). Prefixes only on secrets: `relay_live_`, `whsec_` | bigint counters, prefixed ids |
| Database | `postgres:18.6` StatefulSet, volume mounted at `/var/lib/postgresql`, our own StorageClass `local-path-retain` (the default deletes data) | Neon / Supabase (brief: everything on our own VPS) |
| Orchestration | k3s v1.36.5 (Traefik, metrics-server, local-path, secrets encryption on) | Docker Compose |
| HTTPS | cert-manager v1.21.2 + Let's Encrypt, staging first; HTTP → HTTPS redirect in Traefik with `allowACMEByPass` | certbot by hand |
| Images | GHCR, public package ([decision 0004](decisions/0004-public-container-images.md)), tag = git SHA | Docker Hub, a private package with a pull secret |
| CI/CD | GitHub Actions: test → build → push → deploy over SSH as a `deploy` user with a forced command (port 6443 stays closed), then check `/version` | Self-hosted runner, opening 6443, Argo CD |
| Observability | Slim kube-prometheus-stack + Loki + Alloy (Promtail is end-of-life); Grafana Cloud free tier as fallback | Datadog |
| Backups | Nightly CronJob: `pg_dump` → **Amazon S3** (eu-north-1), one timed restore | Volume snapshots, R2, B2 |
| IaC | Kubernetes YAML and scripts in git; **Terraform only for the S3 backup bucket** and its IAM user | Terraform for everything (no provider for one.com or get.tech; Helm via Terraform needs 6443) |
| Scaling / zero downtime | **Planned, never built:** an HPA on the API (2–4 pods, which would mean dropping `replicas:`). Today every Deployment pins its replicas by hand; workers fixed at 2; RollingUpdate maxUnavailable 0, readiness probe, preStop sleep, graceful SIGTERM | KEDA (stretch), blue-green |

**Left out on purpose:** rate limiting per IP (Traefik sees every client as `10.42.0.1`),
encrypting the signing-secret column (we protect the backups instead), OpenAPI tooling
(`docs/api.md` + shared types instead).

## Infrastructure facts

- **VPS:** one.com, Ubuntu 26.04, 4 vCPU / 8 GB / 200 GB, hostname `cloud-server-10692294`.
- **Access:** personal users `devinder` and `abdikhani`, SSH keys only, no root login.
  Log in with `ssh relay` (alias in each person's `~/.ssh/config`). `administrator` is
  one.com's default account, kept as a backup.
- **Firewalls:** two layers. one.com's network firewall (web panel) allows only TCP 22, 80 and
  443 over IPv4, and nothing over IPv6. ufw on the server allows 22, 80, 443 and the k3s
  networks 10.42.0.0/16 and 10.43.0.0/16. ufw can't filter ports that Kubernetes publishes
  itself (NodePorts, such as Traefik's 30795 and 32338), so only one.com's firewall blocks
  those. It must never get an "All" rule again (it had one until 29 Oct). Check from outside,
  both ways: `443` must answer AND `30795` must not. A check that only expects a failure can't
  tell a blocked port from a broken command. macOS: `nc -z -G 3 81.88.23.71 <port>`;
  Linux (netcat-openbsd has no `-G`): `nc -z -w 3 81.88.23.71 <port>`.
- **kubectl:** only on the server (`ssh relay`, then `kubectl …`). Port 6443 stays closed.
- **Deploy path:** GitHub Actions (environment `production`, main only) logs in as the Linux
  user `deploy`, whose key can only start `/usr/local/bin/relay-deploy`. The script deploys a
  commit only if it is on main, using the Kubernetes account `deployer` (namespace `relay`
  only, no Secrets). Which folder is applied how: [`k8s/README.md`](../k8s/README.md).
- **Two replicas, one node:** the API runs 2 pods behind Traefik. That gives zero-downtime
  rollouts and protection against one crashing process. It is **not** high availability: if
  the VPS goes down, everything is down.
- **Domain:** `myrelay.tech`, DNS at get.tech. A records for `api`, `cdn` (the Relay dashboard)
  and `grafana` (the ops dashboard: metrics and logs) all point to the VPS. **No AAAA records**:
  the cluster is IPv4-only, and Let's Encrypt prefers IPv6 when it exists.
- **HTTP → HTTPS:** `k8s/platform/traefik-config.yaml` (a HelmChartConfig) redirects port 80 to
  443 for every host with a permanent redirect (301 for GET, 308 for other methods, so a POST
  keeps its method and body), except `/.well-known/acme-challenge/`, so certificate checks
  still work over plain HTTP.

## Git workflow

- `main` is protected: changes only through a PR with 1 approval from the other person,
  no force-pushes, no deletion, and the required checks `api-test` and `deploy-script-test`
  must be green. An approval only counts for the newest push.
- Branch names: `feat/…`, `fix/…`, `docs/…`, `infra/…`, `test/…`.
- Commit messages: `type: short summary` (for example `docs: add team context`).
- Small PRs, squash-merge, delete the branch after merging.
- Only commit and push when the person doing the work says so.

## Where we are

Phase 0 (server foundation) is done: VPS hardened, k3s, cert-manager with Let's Encrypt
issuers, and a temporary hello-world app on https://api.myrelay.tech with a trusted
certificate.

Phase 1 (walking skeleton) is done (29 Oct). Every merge to `main` is tested, built and
deployed by the pipeline, then checked from outside on `https://api.myrelay.tech/version`.
The API runs as 2 pods with probes, a rolling update and graceful shutdown. Tested live:
76,466 requests from 20 clients during a deploy, 0 failed; a deliberately failed deploy rolled
back to the last good commit with 119,824 requests and 0 failed, and users never saw the bad
version. The hello app is gone.

Phase 2 (database foundation) is live (1–2 Nov):
- **Guards on namespace `relay`:** Pod Security `restricted`, and only ClusterIP Services.
- **Postgres 18.6:** a StatefulSet on a disk that is kept even when its claim is deleted
  (`local-path-retain`), applied by hand. The app logs in as `relay`, not a superuser.
- **Migrations:** every deploy runs them first, in a migrate Job (dbmate, forward-only,
  [decision 0006](decisions/0006-migrations-expand-contract.md)). Migration 001, schema v1, is
  applied.
- **The API connects:** it waits for the database before it listens, readiness never checks the
  database, and an unreachable database answers 503 `service_unavailable`.
- **Tests:** they run against a real Postgres, logged in as `relay`, on the laptop and in CI.

Tested live:
- **Deletion drill:** a marker row survived deleting the pod, the StatefulSet and the claim; the
  same disk was re-attached.
- **A migration that can't start** fails within its 150 s limit, so the deploy stops instead of
  hanging.
- **A rollback to Phase 1's release** (from before migrations existed) worked under load:
  123,904 requests, 0 failed.

Phase 3 (core API) is done and live (4 Nov): API-key auth, endpoints with the SSRF check
and a 20-endpoint limit, events with idempotency, delivery reads and CORS. The dashboard is
live on https://cdn.myrelay.tech.

Phase 5 (the dashboard on cdn) is done (7 Nov): all four screens read and write the real API
through one axios client, with one place deciding what each kind of failure means
(#42). Checked on the deployed site with a real key: an endpoint created through the form,
an event sent by curl, the worker's retries visible as they happened, and Replay resetting the
delivery. `src/mockStore.ts` is gone and no fixture data ships in the bundle.

Phase 4 (worker) is live (6 Nov): #36, #37 (replay), #39 (staged infrastructure) and #40
(activation) are merged. Two workers run with a pool of five connections each. Their NetworkPolicy
was applied and checked before activation, including the isolated address-exclusion test. Live
checks showed valid signatures on 500, 500, 200 → delivered with three attempts; a failing delivery
became dead after five tries, replay returned 202 with attempts reset to zero, and it tried again.

Phase 7 (metrics and logs) is partly live, ahead of its place in the plan: kube-prometheus-stack,
Loki and Alloy were installed with Helm into namespace `monitoring` on 3 Nov and are running.
Logs from namespace `relay` are centralised and searchable in Grafana, the worker's included.
Still missing: application metrics (no `/metrics` endpoint), a published address (Grafana is
ClusterIP, SSH tunnel only), and the Helm values in git, which today is the only part of the
system this repository cannot rebuild.

Phase 6 (backups) is built and restore-tested (7 Nov); its first scheduled run is 8 Nov at 03:00.
It consists of the S3 bucket and an upload-only IAM user built with
Terraform (#43), and a nightly `pg_dump` CronJob at 03:00 Europe/Stockholm (#46). The upload is a
single `put-object`, never `aws s3 cp`, because the key may not do multipart. Proven by a timed
drill: the recorded version downloaded by VersionId with its checksum checked, restored as `relay`
in 1.46 s, every count and id identical to production, and a wrong-password run uploaded nothing.
The drill also found that the restore pipeline must run in bash, not zsh, whose MULTIOS option
would mix the CLI's JSON into the dump. Still missing: an alert when a night fails or is skipped.

The plan in order: 1 walking skeleton · 2 database foundation · 3 core API · 4 worker ·
5 dashboard on cdn (Abdikhani, in parallel) · 6 backups + Terraform (Abdikhani, in parallel) ·
7 metrics and logs (Abdikhani, in parallel) · 8 VG under load · 9 docs and defense · 10 submit.
