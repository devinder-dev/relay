# Relay

**Relay makes sure messages between apps arrive, even when the receiving app is down.**

A webhook is an HTTP request that tells another app something happened, such as `invoice.paid`.
The receiver can be down, receive duplicates, or need proof of who sent the message.
Relay accepts events, saves deliveries in Postgres, and provides delivery history through its API.
The Phase 4 worker is live, with signed background delivery, retries and replay.
This is our exam project for Chas Academy's *Avancerad fullstackutveckling, test och DevOps*.

## Addresses

| Service | Address | What is there |
|---|---|---|
| API | https://api.myrelay.tech | Core API. [`/version`](https://api.myrelay.tech/version) shows the running commit |
| Relay dashboard (static files on cdn) | https://cdn.myrelay.tech | Connect, delivery log, delivery detail and endpoints screens, reading and writing the real API. Paste an API key to see that owner's deliveries |
| Ops dashboard (Grafana: metrics and logs) | No public address: reachable only over an SSH tunnel | Grafana, Prometheus, Loki and Alloy run in namespace `monitoring`. Its Service is ClusterIP with no Ingress, so nothing is published on `grafana.myrelay.tech`. Reach it with `ssh -L 3000:localhost:3000 relay`, then on the server `kubectl -n monitoring port-forward svc/monitoring-grafana 3000:80`, and open `http://localhost:3000` |
| Source | [devinder-dev/relay](https://github.com/devinder-dev/relay) | This repository |

## How it works

The API, worker and replay are live. Worker code
[#36](https://github.com/devinder-dev/relay/pull/36) and replay
[#37](https://github.com/devinder-dev/relay/pull/37) are merged. The worker was activated on
6 Nov with two replicas and a database pool of five connections per worker.

```mermaid
flowchart LR
    P[Producer] --> T[Traefik]
    T --> A[API pods]
    A --> Q[(Postgres queue)]
    Q --> W[Worker]
    W --> R[Receiver]
```

1. The producer sends `POST /v1/events` with its API key.
2. The API validates the request and saves the event and one delivery per matching endpoint in
   one transaction. It answers `202 Accepted`. An `Idempotency-Key` makes a repeated request
   return the original answer without creating another event.
3. Workers claim due deliveries using `FOR UPDATE SKIP LOCKED`: a worker skips rows another
   worker has locked. Each claim increments the try count and takes a 60-second lease, a temporary
   right to process the delivery. No database connection is held during the HTTP request.
4. The worker checks the destination again, signs the exact body using Standard Webhooks, and
   sends a POST with a 10-second deadline. Each try gets a fresh signature.
5. A 2xx response means delivered. Other responses, redirects and connection failures use the
   retry schedule with jitter, a small random change to each wait. The default allows eight tries
   over about 21 hours; exhausted deliveries become `dead` and can be replayed.
6. The result changes delivery state only if its `lease_id` still matches. This fencing token
   prevents an old worker from overwriting a newer claim. An expired lease makes unfinished work
   eligible again.
7. Delivery is at least once: the receiver must drop duplicates using `webhook-id`, the event id
   that stays the same across retries and replays.

The request and response shapes are in [the API contract](docs/api.md).

## Architecture and deploy path

```mermaid
flowchart TD
    PR[Pull request] --> C[Required checks: api-test and deploy-script-test]
    C --> M[Reviewed merge to main]
    M --> G[GitHub Actions: test, build, push commit-tagged images]
    G --> S[SSH as deploy user: forced command]
    S --> D[relay-deploy]
    D --> G1[Gate 1: exactly 40 hexadecimal characters]
    G1 --> G2[Gate 2: commit belongs to main]
    G2 --> J[Migrate Job: forward-only SQL]
    J --> A[Apply commit manifests and wait for Deployments]
    A --> K[k3s]
    A -->|Failure| R[Redeploy last good commit: manifests and images]
    R --> K
```

Everything runs on one VPS (virtual private server). The provider firewall and the server's ufw
firewall form two layers. k3s runs the containers; Traefik routes incoming requests to the API's
two pods; cert-manager renews HTTPS certificates. Two pods protect rollouts and process failures,
but a failed VPS still takes the whole service down.

`relay-deploy` serializes deploys with a lock. It runs migrations before applying app manifests.
Rollback restores code and manifests, not the old database schema: migrations must remain
compatible with the previous release. Resources added only by a failed release remain because
the deploy account cannot delete. See [the manifest guide](k8s/README.md) and
[the server rebuild runbook](infra/server/README.md).

## Requirements

| Requirement | Status | Evidence (file, test or measurement) |
|---|---|---|
| G1: backend on our VPS over HTTPS | Done | [API Deployment](k8s/app/deployment.yaml), API address above, recorded outside checks on 4 Nov |
| G2: static files served from cdn | Done | [Dashboard manifests](k8s/app/dashboard.yaml), merged [#24](https://github.com/devinder-dev/relay/pull/24) and [#30](https://github.com/devinder-dev/relay/pull/30). The screens talk to the API ([#42](https://github.com/devinder-dev/relay/pull/42)) |
| G3: every merge tested, built and deployed | Done | [Pipeline](.github/workflows/pipeline.yml), [deploy script](infra/server/relay-deploy.sh), deploy and rollback measurements below |
| G4: unit, integration and end-to-end tests in the pipeline | Done | [Pipeline](.github/workflows/pipeline.yml). Unit: `bun test src` (API) and `node --test` (dashboard, in CI since [#42](https://github.com/devinder-dev/relay/pull/42)). Integration: [API tests against a real Postgres](api/test/integration/). End-to-end: [Playwright](dashboard/playwright.config.ts) drives a real browser over the real API client, with the requests answered in-browser from fixtures so row counts stay exact |
| G5: daily database backups | Built and restore-tested; first scheduled run 8 Nov | Nightly `pg_dump` to S3 at 03:00 Europe/Stockholm ([CronJob](k8s/data/backup-cronjob.yaml)), into a versioned, encrypted bucket with public access blocked, built by [Terraform](infra/terraform/backup/) and written by an upload-only IAM user that cannot read, list or delete. Live: the CronJob is applied, but it has **not yet fired on its schedule**: its `lastSuccessfulTime` (2026-11-07 14:46:55Z) comes from a Job started by hand from the same template, which proves the Job works, not the schedule. **Restore proven, not assumed:** that exact object, by VersionId with its SHA-256 checked against the Job's own log line, restored as `relay` into a throwaway database in **1.46 s**, and every count, id, constraint and index matched production. Runbook: [6d–6g](infra/server/README.md#6-data-postgres-step-23-backups-in-phase-6) |
| G6: metrics and logging | Mostly done | Live in namespace `monitoring` since 3 Nov, installed with Helm: kube-prometheus-stack 92.17.1 (Prometheus, Grafana, kube-state-metrics, node-exporter), Loki 20.2.2 and Alloy 1.15.0, all `Running`. Alloy ships pod logs to Loki, so the API's and the worker's JSON logs are centralised and searchable in Grafana - the worker's retry-to-dead cycle on 6 Nov was read back out of Loki. **Two gaps:** no application metrics (no `/metrics` endpoint, and no ServiceMonitor targets our pods, so only cluster and node metrics are scraped), and the Helm values are not in git, so this is the one part of the system the repository cannot rebuild |
| VG1: at least two instances behind a load balancer | Done | Two API pods behind Traefik in [Deployment](k8s/app/deployment.yaml) and [Ingress](k8s/app/ingress.yaml); one VPS remains a single point of failure |
| VG2: zero-downtime deploys | Done | 76,466 health requests during a deploy, zero failed; bounded test described below |
| VG3: autoscaling | Not done | No HorizontalPodAutoscaler exists yet: `kubectl get hpa -A` returns nothing, and every Deployment pins its replica count by hand, so pod count never changes with load. One is written and reviewed ([#45](https://github.com/devinder-dev/relay/pull/45)): 2 to 4 API pods on CPU, as a platform file the pipeline cannot change. It is deliberately merged last, because applying it needs a window with no other merges - any deploy re-applies `replicas: 2` and resets the count. Until it is applied and measured under load, this is not done |

## Proven live

These are recorded checks, not a fresh production audit.

| Check | Traffic and result | What it proves and its limit |
|---|---|---|
| Deploy, 29 Oct | ApacheBench (`ab`), 20 concurrent connections, keep-alive, 300 seconds to `/health/live`: **76,466 requests, 0 failed** | Health requests stayed available during the rollout; not event-delivery throughput |
| Automatic rollback, 29 Oct | `ab`, 20 concurrent connections, keep-alive, 420 seconds: **119,824 requests, 0 failed**. A separate `/version` loop never saw the bad version | A deliberately missing image triggered rollback. The saved rollback log doesn't record which endpoint `ab` used (the deploy test used `/health/live`) |
| Postgres restart, 2 Nov | `ab`, 20 concurrent connections, keep-alive, 150 seconds to `/health/ready`: **49,192 requests, 0 failed**. All 318 separate readiness checks returned 200 | API pods stayed ready with zero restarts during about three seconds of database downtime. The linked load script confirms `ab`; no database-backed route was exercised |
| Worker NetworkPolicy activation checks, 6 Nov | After the policy was applied by hand and before the worker ran, a pod with the worker's label reached the demo receiver through its Service name on port 80 (200) and example.com (200). The Kubernetes API and a dashboard pod were refused (curl exit 7) | The worker's outgoing rules allowed the demo receiver and public HTTPS while refusing these internal destinations |
| Isolated NetworkPolicy probe E, 6 Nov | Public HTTPS answered with the worker's rules, was refused after adding only that destination to `ipBlock.except`, then answered again after removing the exception | The address-exclusion rule was isolated and verified. The controller rejects denied traffic (curl exit 7), rather than dropping it |
| Signed retry to success, 6 Nov | Our internal demo endpoint received `demo.ping` with `fail: 2`: 500, 500, 200; delivery became `delivered` with `attempts: 3`. All three receiver requests had valid Standard Webhooks signatures | Signed delivery and retry to success worked against our own receiver inside the cluster; not an external receiver or capacity test |
| Dead delivery and replay, 6 Nov | `demo.ping` with `fail: 99` became `dead` after five tries on the demo schedule. Replay returned 202, `pending`, `attempts: 0`, then tried again. A malformed replay id returned 404 | Retry exhaustion and replay worked live; no claim that the always-failing delivery eventually succeeded |
| Backup and timed restore, 7 Nov | A backup Job dumped the production database and uploaded it in one `put-object` (17,851 bytes). That exact version was downloaded by VersionId with `--checksum-mode ENABLED` and restored as `relay` into a throwaway Postgres: `pg_restore` exit 0 in **1.46 s**, the SHA-256 S3 returned equal to the one the Job logged, and tables, migration version, all six row counts, constraints, indexes and the first delivery ids identical to production. A wrong-password run failed all three attempts and uploaded nothing. The drill Pod was deleted afterwards | This dump restored, and the restored copy is the database rather than merely a file of the right size. One restore, of a small database, into a throwaway pod - not a rehearsal of restoring into production, which is written but untested |
| Dashboard over the real API, 7 Nov | On https://cdn.myrelay.tech with a real key: the delivery log, the detail screen and the endpoints screen all read production. An endpoint created through the form answered `POST /v1/endpoints` **201**; an event sent by `curl` answered **202**; the worker then retried it against a receiver that refuses POST (405) on the demo schedule, and Replay from the detail screen reset it to `attempts: 0`. Status codes read from the API pod's own log, not from the browser | The dashboard and the API agree on the contract in production, not only in tests. Not a capacity test, and one owner's data only |
| Core API outside checks, 4 Nov | Six SSRF destinations refused with 422; missing-key requests gave 401; cdn CORS preflight gave 204 and an allow-origin header, an untrusted origin got none | SSRF (server-side request forgery) checks prevent registering internal destinations. CORS controls which browser origins may read responses. These checks do not prove worker delivery; the six SSRF attack URLs still returned 422 after #36 |

The load came from one laptop. Deploy traffic used a health endpoint, alongside separate
version checks; the rollback log doesn't record its load endpoint. These are availability checks, not a capacity benchmark. A k6 capacity test is
still to come. The Postgres test proves readiness behavior, not successful writes during an outage.

## Security

- API keys are stored as SHA-256 hashes; the API exposes only their prefix in `GET /v1/me`.
- Endpoint creation checks for SSRF. The Phase 4 worker checks again on every send and never
  follows redirects. Its operator-managed origin exception is global, including the internal
  HTTP demo receiver; customers cannot change that list.
- Phase 4 pins each connection to the address it just checked, closing the DNS-rebinding gap
  where a name changes address between check and connection. NetworkPolicy adds outgoing
  filtering; the worker's policy was installed before activation and checked from a pod carrying
  the worker's label, including the isolated address-exclusion test above.
- Phase 4 uses Standard Webhooks signatures (HMAC-SHA256) so receivers can verify the sender and
  body. Receivers must verify send time and deduplicate event ids.
- Namespace `relay` enforces Pod Security `restricted`: pods cannot run privileged or as root.
- Services in `relay` must be ClusterIP, reachable inside the cluster, with no `externalIPs`.
  Public web access goes through Traefik.
- The deploy SSH key has a forced command: it can start only `relay-deploy`. Its Kubernetes
  account is confined to `relay`, cannot manage Secrets, and cannot widen its own platform rights.
- Operational secrets belong in Kubernetes Secrets or GitHub Actions Secrets, never in git or
  container images. Endpoint signing keys are stored in Postgres; that column is not encrypted.

## Run it locally

Use **Bun 1.4.4**, running **Docker**, and **Node 24.22.1** with npm for the dashboard.
Run these from the repository root:

```sh
cd api
bun install
bun run db:up
bun run test:db
```

`db:up` recreates only the script's labelled throwaway Postgres container, deleting its old test
storage, then applies migrations. It listens locally on port 55432. The test script exports its
own `DATABASE_URL`; that variable does not carry back into your shell. To run the API against
this test database, use the same documented throwaway login:

```sh
export DATABASE_URL='postgres://relay:test@localhost:55432/relay?sslmode=disable'
bun run dev
```

The API listens on port 8080 by default. For the authenticated routes, create a local owner in the
same terminal (it prints the owner's API key once; keep it private, and never use a production key
locally):

```sh
bun src/cli/create-owner.ts --name "Local"
```
Stop and remove the throwaway database with `bun run db:down` from `api/`.

In a separate terminal, from the repository root:

```sh
cd dashboard
npm ci
npm run dev
```

Open `http://localhost:5173`. Vite forwards `/v1` to an API, so the app is same-origin while
developing and CORS never applies; the default target is an API on this machine. To work against
production instead, say so explicitly - and note that it reads and writes real data:

```sh
RELAY_API=https://api.myrelay.tech npm run dev
```

Paste an API key and the screens show that owner's real endpoints and deliveries.

## Tests

| Layer | What it checks | Run |
|---|---|---|
| API unit | Configuration, validation and pure helpers | In `api/`: `bun run test:unit` and `bun run typecheck` |
| Real Postgres integration | Schema constraints, authentication, owner isolation, endpoint limits, event transactions, idempotency races and delivery reads | In `api/`, with Docker running: `bun run db:up`, then `bun run test:db` (also runs unit tests) |
| Phase 4 worker and replay | Signing, pinned transport, retries, leases, shutdown, receiver verification and replay conflicts | In `api/`: `bun run test:db`; worker and replay tests are now on `main` and this branch |
| Playwright end-to-end | A real browser exercises the real API client. Playwright answers the requests in the browser from fixtures, so the shipped code runs while the row counts stay fixed and assertions can be exact | In `dashboard/`: `npx playwright install chromium`, then `npm run test:e2e`; Playwright starts Vite itself |
| Deploy-script harness | Deployment gates, migrations, failures and rollback using fake commands, without a server | From repo root: `bash infra/server/test-relay-deploy.sh infra/server/relay-deploy.sh` |
| Image smoke tests | Migrations run twice inside the built API image; dashboard serves its HTML and JavaScript bundle | Run by [the pipeline](.github/workflows/pipeline.yml). Merged #36 added signed and tampered requests against the receiver in the production image |

## Status and what's not done yet

Phase 3 is live: API-key authentication, endpoint registration with SSRF checks and a 20-endpoint
limit, idempotent events, delivery reads and CORS. The dashboard is served on cdn and reads and
writes the real API ([#42](https://github.com/devinder-dev/relay/pull/42)).

Phase 4 is live (6 Nov): worker code [#36](https://github.com/devinder-dev/relay/pull/36),
replay and the demo origin [#37](https://github.com/devinder-dev/relay/pull/37), staged worker
and receiver infrastructure [#39](https://github.com/devinder-dev/relay/pull/39), and worker
activation [#40](https://github.com/devinder-dev/relay/pull/40) are merged and live. The worker
was staged at zero replicas, its NetworkPolicy applied and checked by hand, then activated with
two replicas and a pool of five connections per worker. Live checks proved signed retry to
success, five-try exhaustion, replay and the isolated NetworkPolicy exception rule.
The stop switch was tested live: scaling the worker to zero removed both pods, and scaling back
to two brought two running workers back (`kubectl -n relay scale deployment/relay-worker`).

The production demo configuration uses a short retry schedule, `5s,30s,2m,10m`, while grading:
five tries before `dead`. The code default remains eight tries over about 21 hours
(`5s,1m,5m,30m,2h,6h,12h` between tries, with jitter).

Not implemented here: `DELETE /v1/endpoints/:id` and application metrics. The delete route in the
contract describes intended behaviour; nothing exposes `/metrics`, so Prometheus scrapes the
cluster and the nodes but nothing about events, deliveries or retries.

Autoscaling (VG3) is written and reviewed ([#45](https://github.com/devinder-dev/relay/pull/45)) but
not yet applied, so the measurement is still missing: today every Deployment pins its replica count
by hand. A k6 capacity test is also still to come, and nothing alerts on a backup that fails or a
night that is skipped - someone checks by hand.

## Decisions

- [0001: Fastify](docs/decisions/0001-web-framework-fastify.md) — familiar HTTP framework with logging, shutdown and request injection tests.
- [0002: Dashboard stack](docs/decisions/0002-dashboard-stack.md) — Vite, React, Tailwind and React Router; records the intended axios client.
- [0003: API structure](docs/decisions/0003-api-code-structure.md) — Zod validation, route/service/repository layers and one error handler.
- [0004: Public container images](docs/decisions/0004-public-container-images.md) — anonymous pulls from GHCR, with no secrets baked into images.
- [0005: Dashboard toolchain](docs/decisions/0005-dashboard-toolchain.md) — npm, pinned Node and oxlint, separate from the API's Bun runtime.
- [0006: Forward-only migrations](docs/decisions/0006-migrations-expand-contract.md) — add compatible schema first and remove old fields only in later releases.
- [0007: Idempotent events](docs/decisions/0007-idempotency-unique-constraint.md) — a unique constraint prevents duplicates; a separate read sees the committed winner.

- [0008: Worker transport](docs/decisions/0008-worker-transport.md) — merged in #36; replaces decision 0002's proposed worker transport with a checked, pinned connection.

## Team

- **Devinder Singh:** backend, database and infrastructure; core API, deploy pipeline, namespace guards and rollout/rollback tests (for example #13–17, #21–22, #26–27 and #31–35).
- **Abdikhani Mohamed:** frontend and quality; dashboard types and screens, the API client and its error handling, toolchain, manifests, image pipeline, unit and browser tests (#2, #7, #9, #23–24, #28, #30 and #42).

Every PR was reviewed by the other. Both must be able to explain the whole system.
