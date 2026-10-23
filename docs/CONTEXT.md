# Relay: team context

Working agreements, architecture and decisions. Read this before working on the project.

## The project

**Relay makes sure messages between apps arrive, even when the receiving app is down.**
Webhook delivery as a service (like Svix or Hookdeck), built as the exam project for
Chas Academy's "Avancerad fullstackutveckling, test och DevOps".

- **Team:** Devinder Singh (backend + infrastructure) and Abdikhani Mohamed (frontend + quality).
  Every PR is reviewed by the other person. Both must be able to explain the whole system.
- **Dates:** Tenta 4 Wed 28 Oct · G complete target Fri 30 Oct · **oral defense Wed 4 Nov
  (live demo)** · code submission Sun 8 Nov.
- **Strategy:** build all G requirements first, then VG (2+ replicas, zero-downtime deploys,
  autoscaling shown under load).

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
- **Docs over memory.** Check current official docs for Bun, Hono, cert-manager, k3s and so on
  instead of guessing APIs.
- **Security scans.** Scan new security-sensitive code (auth, SQL, signing, webhooks, user input)
  with Snyk where available, and fix findings before the PR.

## Security rules

- Never share secrets in chat or commits: API keys, passwords, tokens, kubeconfig, `.env` files.
- Secrets live only in **GitHub Actions secrets** or **Kubernetes Secrets**. Never in git.
- The kubeconfig is an admin password. It stays on the server in `~/.kube/config`.
- Ask the other person before any destructive command on the VPS, the database or DNS.
- Never expose to the internet: Postgres (5432), the Kubernetes API (6443), `/metrics`.
- Endpoint URLs from customers must not point to internal or private addresses (SSRF).

## How Relay works

1. A producer sends `POST /events` with its API key.
2. The API validates it and, in **one transaction**, saves the event plus one **delivery** row
   per subscribed endpoint, then answers **202 Accepted**.
3. Worker pods claim due deliveries with `SELECT … FOR UPDATE SKIP LOCKED`.
4. The worker signs the body (HMAC-SHA256, header `Relay-Signature: t=<unix>,v1=<hex>`,
   signed string `t + "." + body`) and POSTs it with a 10 s timeout.
5. 2xx = delivered. Error or timeout = retry with exponential backoff + jitter
   (draft: 1 min, 5 min, 30 min, 2 h, 6 h, 12 h). After the last try: **dead**, replayable.
6. At-least-once delivery: each event has a unique id; producers may send `Idempotency-Key`.

**Data model:** `owners` (id, name, api_key_hash) · `endpoints` (id, owner_id, url, secret,
event_types[], paused_until, created_at) · `events` (id, owner_id, type, payload jsonb,
idempotency_key, created_at; UNIQUE (owner_id, idempotency_key)) · `deliveries` (id, event_id,
endpoint_id, status pending|delivered|dead, attempts, next_attempt_at, last_status_code,
updated_at; INDEX (status, next_attempt_at)) · `attempts` (id, delivery_id, status_code,
duration_ms, error, created_at).

**API:** `POST /endpoints` · `POST /events` · `GET /deliveries?status=` · `GET /deliveries/:id`
· `POST /deliveries/:id/replay` · `GET /health/live` (no DB check) · `GET /health/ready`
(checks DB) · `GET /metrics` (cluster-internal only).

## Stack and decisions

| Area | Choice | Not chosen |
|---|---|---|
| Runtime | Bun 1.4 + TypeScript | Node (more common, but we know Bun) |
| Unit + integration tests | `bun test`; integration against a real Postgres (Docker locally, service container in GitHub Actions) | Testcontainers (no official Bun support), mocked DB |
| E2E tests | Playwright, runs on Node in the dashboard folder | Cypress |
| Queue | Postgres `SKIP LOCKED` | RabbitMQ (stretch goal only, as a "doorbell"; dual-write problem) |
| Database | Postgres in k3s, StatefulSet + local-path volume with Retain | Neon / Supabase (brief: everything on our own VPS) |
| Orchestration | k3s v1.36.5 (Traefik, metrics-server, local-path, secrets encryption on) | Docker Compose |
| HTTPS | cert-manager v1.21.2 + Let's Encrypt, staging first | certbot by hand |
| Images | GHCR, tag = git SHA | Docker Hub |
| CI/CD | GitHub Actions: test → build → push → deploy | Argo CD |
| Observability | kube-prometheus-stack + Loki (Grafana Cloud free tier as fallback) | Datadog |
| Backups | Nightly CronJob: pg_dump + gzip → S3-compatible bucket, one tested restore | Volume snapshots |
| IaC | Kubernetes YAML in git; Terraform for the backup bucket, GitHub settings and Helm add-ons (Phase 4) | Terraform for everything (no provider for one.com or get.tech) |
| Scaling / zero downtime | HPA on CPU; RollingUpdate maxUnavailable 0, readiness probe, graceful SIGTERM | KEDA (stretch), blue-green |

**Still open:** web framework (Hono, Elysia or Express), database library (`Bun.sql`,
postgres.js or Drizzle), how Actions reaches the cluster (SSH vs Kubernetes API),
backup storage (R2, B2 or AWS), final retry schedule, Grafana address.

## Infrastructure facts

- **VPS:** one.com, Ubuntu 26.04, 4 vCPU / 8 GB / 200 GB, hostname `cloud-server-10692294`.
- **Access:** personal users `devinder` and `abdikhani`, SSH keys only, no root login.
  Log in with `ssh relay` (alias in each person's `~/.ssh/config`). `administrator` is
  one.com's default account, kept as a backup.
- **Firewalls:** one.com's network firewall + ufw. ufw allows 22, 80, 443 and the k3s networks
  10.42.0.0/16 and 10.43.0.0/16. Ports 80/443 are still closed in one.com's panel (step 0.12).
- **kubectl:** only on the server (`ssh relay`, then `kubectl …`). Port 6443 stays closed.
- **Domain:** `myrelay.tech`, DNS at get.tech. `api.myrelay.tech` has an A record to the VPS.
  **No AAAA records**: the cluster is IPv4-only, and Let's Encrypt prefers IPv6 when it exists.
  Planned: `cdn.myrelay.tech` (dashboard), `grafana.myrelay.tech` (name not final).

## Git workflow

- `main` is protected: changes only through a PR with 1 approval from the other person,
  no force-pushes, no deletion. Once the pipeline exists, it must pass too.
- Branch names: `feat/…`, `fix/…`, `docs/…`, `infra/…`, `test/…`.
- Commit messages: `type: short summary` (for example `docs: add team context`).
- Small PRs, squash-merge, delete the branch after merging.
- Only commit and push when the person doing the work says so.

## Where we are

Phase 0 (server foundation): VPS hardened, k3s and cert-manager installed, repo created.
Next: Let's Encrypt issuers, open 80/443 at one.com, hello world on https://api.myrelay.tech.
