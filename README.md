# Relay

**Relay makes sure messages between apps arrive, even when the receiving app is down.**

A webhook is an HTTP request that tells another app something happened, such as `invoice.paid`.
The receiver can be down, receive duplicates, or need proof of who sent the message.
Relay accepts events, saves deliveries in Postgres, and provides delivery history through its API.
The Phase 4 worker adds signed background delivery and retries; its live state is still to confirm.
This is our exam project for Chas Academy's *Avancerad fullstackutveckling, test och DevOps*.

## Addresses

| Service | Address | What is there |
|---|---|---|
| API | https://api.myrelay.tech | Core API. [`/version`](https://api.myrelay.tech/version) shows the running commit |
| Relay dashboard (static files on cdn) | https://cdn.myrelay.tech | Connect, delivery log, delivery detail and endpoints screens. Currently uses mock data, including the Connect check, rather than the real API |
| Ops dashboard (Grafana: metrics and logs) | TODO(Abdikhani): address or how to reach it | SSH tunnel access only; no verified public address |
| Source | [devinder-dev/relay](https://github.com/devinder-dev/relay) | This repository |

## How it works

The API through saving the queue is live. The worker flow below is built and tested in
[#36](https://github.com/devinder-dev/relay/pull/36), which is still open.
TODO(Devinder): confirm whether the worker is live or not live at submission.

```mermaid
flowchart LR
    P[Producer] --> T[Traefik]
    T --> A[API pods]
    A --> Q[(Postgres queue)]
    Q -. Phase 4 activation pending confirmation .-> W[Worker]
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
   over about 21 hours; exhausted deliveries become `dead` and can be replayed once #37 is live.
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
| G2: static files served from cdn | Done | [Dashboard manifests](k8s/app/dashboard.yaml), merged [#24](https://github.com/devinder-dev/relay/pull/24) and [#30](https://github.com/devinder-dev/relay/pull/30); dashboard uses mock data |
| G3: every merge tested, built and deployed | Done | [Pipeline](.github/workflows/pipeline.yml), [deploy script](infra/server/relay-deploy.sh), deploy and rollback measurements below |
| G4: unit, integration and end-to-end tests in the pipeline | Done | [Pipeline](.github/workflows/pipeline.yml), [API integration tests](api/test/integration/), [Playwright configuration](dashboard/playwright.config.ts); browser tests currently use mocks |
| G5: daily database backups | In progress | Planned in [server runbook, section 6](infra/server/README.md#6-data-postgres-step-23-backups-in-phase-6). TODO(Abdikhani): confirm daily backups and provide restore evidence |
| G6: metrics and logging | In progress | API JSON logs exist; monitoring stack is planned in [team context](docs/CONTEXT.md). TODO(Abdikhani): confirm collected metrics, searchable logs and dashboard evidence |
| VG1: at least two instances behind a load balancer | Done | Two API pods behind Traefik in [Deployment](k8s/app/deployment.yaml) and [Ingress](k8s/app/ingress.yaml); one VPS remains a single point of failure |
| VG2: zero-downtime deploys | Done | 76,466 health requests during a deploy, zero failed; bounded test described below |
| VG3: autoscaling | Not done | Context describes a planned horizontal pod autoscaler, which changes pod count with load. TODO(Abdikhani): confirm whether autoscaling was implemented and measured before submission |

## Proven live

These are recorded checks, not a fresh production audit.

| Check | Traffic and result | What it proves and its limit |
|---|---|---|
| Deploy, 29 Oct | ApacheBench (`ab`), 20 concurrent connections, keep-alive, 300 seconds to `/health/live`: **76,466 requests, 0 failed** | Health requests stayed available during the rollout; not event-delivery throughput |
| Automatic rollback, 29 Oct | `ab`, 20 concurrent connections, keep-alive, 420 seconds: **119,824 requests, 0 failed**. A separate `/version` loop never saw the bad version | A deliberately missing image triggered rollback. TODO(Devinder): confirm the `ab` endpoint for this run; the saved rollback extract omits it |
| Postgres restart, 2 Nov | `ab`, 20 concurrent connections, keep-alive, 150 seconds to `/health/ready`: **49,192 requests, 0 failed**. All 318 separate readiness checks returned 200 | API pods stayed ready with zero restarts during about three seconds of database downtime. The linked load script confirms `ab`; no database-backed route was exercised |
| NetworkPolicy probe, 6 Nov | On a temporary probe pod, the Kubernetes API and our VPS changed from reachable to timeout after applying an egress policy. Public HTTPS and Postgres stayed reachable | Outgoing network filtering worked. The plan still requires an isolated `ipBlock.except` test before worker activation; the Service-IP result may be due to the port rule |
| Core API outside checks, 4 Nov | Six SSRF destinations refused with 422; missing-key requests gave 401; cdn CORS preflight gave 204 and an allow-origin header, an untrusted origin got none | SSRF (server-side request forgery) checks prevent registering internal destinations. CORS controls which browser origins may read responses. These checks do not prove worker delivery |

The load came from one laptop. Deploy traffic used a health endpoint, alongside separate
version checks; the rollback load endpoint still needs confirmation. These are availability checks, not a capacity benchmark. A k6 capacity test is
still to come. The Postgres test proves readiness behavior, not successful writes during an outage.

## Security

- API keys are stored as SHA-256 hashes; the API exposes only their prefix in `GET /v1/me`.
- Endpoint creation checks for SSRF. The Phase 4 worker checks again on every send and never
  follows redirects. Its operator-managed origin exception is global, including the internal
  HTTP demo receiver; customers cannot change that list.
- Phase 4 pins each connection to the address it just checked, closing the DNS-rebinding gap
  where a name changes address between check and connection. NetworkPolicy adds outgoing
  filtering; the probe is recorded above, and worker policy installation still needs confirmation.
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

Open `http://localhost:5173`. The current screens use mock fixtures; entering a real API key does
not turn them into a live API client.

## Tests

| Layer | What it checks | Run |
|---|---|---|
| API unit | Configuration, validation and pure helpers | In `api/`: `bun run test:unit` and `bun run typecheck` |
| Real Postgres integration | Schema constraints, authentication, owner isolation, endpoint limits, event transactions, idempotency races and delivery reads | In `api/`, with Docker running: `bun run db:up`, then `bun run test:db` (also runs unit tests) |
| Phase 4 worker and replay | Signing, pinned transport, retries, leases, shutdown, receiver verification and replay conflicts | Same API commands on the respective #36/#37 branches; these tests are not yet on this branch |
| Playwright end-to-end | A real browser exercises the dashboard's mock-data flows | In `dashboard/`: `npx playwright install chromium`, then `npm run test:e2e`; Playwright starts Vite itself |
| Deploy-script harness | Deployment gates, migrations, failures and rollback using fake commands, without a server | From repo root: `bash infra/server/test-relay-deploy.sh infra/server/relay-deploy.sh` |
| Image smoke tests | Migrations run twice inside the built API image; dashboard serves its HTML and JavaScript bundle | Run by [the pipeline](.github/workflows/pipeline.yml). #36 adds signed and tampered requests against the receiver in the production image |

## Status and what's not done yet

Phase 3 is live: API-key authentication, endpoint registration with SSRF checks and a 20-endpoint
limit, idempotent events, delivery reads and CORS. The dashboard is served on cdn with mock data.

Phase 4 worker code is built and tested in [#36](https://github.com/devinder-dev/relay/pull/36);
replay is built and tested in [#37](https://github.com/devinder-dev/relay/pull/37). Both PRs are
open. Activation is staged: deploy replay and create the demo endpoint and Secret, deploy the
receiver and worker at zero replicas, apply and check the worker's NetworkPolicy, then activate
two workers in a separate release. That gives rollback a known release that stops the worker.
TODO(Devinder): live / not live at submission; record which activation steps and outside delivery
checks have passed, including the isolated NetworkPolicy exception check.

The production demo configuration uses a short retry schedule, `5s,30s,2m,10m`, while grading.
This is the planned configuration, not evidence it is active. The code default remains eight
tries over about 21 hours (`5s,1m,5m,30m,2h,6h,12h` between tries, with jitter).

Not implemented here: `DELETE /v1/endpoints/:id`, application metrics from the worker, and
autoscaling (VG3). The delete route in the contract describes intended behavior. Real API wiring
for the dashboard, k6 capacity results, backup/restore evidence and confirmed monitoring access
also remain to be completed or documented.

## Decisions

- [0001: Fastify](docs/decisions/0001-web-framework-fastify.md) — familiar HTTP framework with logging, shutdown and request injection tests.
- [0002: Dashboard stack](docs/decisions/0002-dashboard-stack.md) — Vite, React, Tailwind and React Router; records the intended axios client.
- [0003: API structure](docs/decisions/0003-api-code-structure.md) — Zod validation, route/service/repository layers and one error handler.
- [0004: Public container images](docs/decisions/0004-public-container-images.md) — anonymous pulls from GHCR, with no secrets baked into images.
- [0005: Dashboard toolchain](docs/decisions/0005-dashboard-toolchain.md) — npm, pinned Node and oxlint, separate from the API's Bun runtime.
- [0006: Forward-only migrations](docs/decisions/0006-migrations-expand-contract.md) — add compatible schema first and remove old fields only in later releases.
- [0007: Idempotent events](docs/decisions/0007-idempotency-unique-constraint.md) — a unique constraint prevents duplicates; a separate read sees the committed winner.

Worker transport decision 0008 is part of open [#36](https://github.com/devinder-dev/relay/pull/36).
It replaces decision 0002's proposed worker transport with a checked, pinned connection.

## Team

- **Devinder Singh:** backend, database and infrastructure; core API, deploy pipeline, namespace guards and rollout/rollback tests (for example #13–17, #21–22, #26–27 and #31–35).
- **Abdikhani Mohamed:** frontend and quality; dashboard types, mock-data screens, toolchain, manifests, image pipeline and browser tests (#7, #9, #23–24, #28 and #30).

Every PR was reviewed by the other. Both must be able to explain the whole system.
