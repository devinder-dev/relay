# Relay

**Relay makes sure messages between apps arrive, even when the receiving app is down.**

When something happens in one app, other apps often need to know: an invoicing app wants to
tell a customer's bookkeeping system that `invoice.paid` just happened. The usual way is a
webhook, an HTTP POST from one server to another. Sending one is easy. Sending them reliably
is hard: the receiver can be down, it can get the same event twice, it must be able to trust
the sender, and nobody can see what was delivered.

Relay sits in the middle:

- **Accepts** events from your app in milliseconds (`202 Accepted`) and delivers them in the background.
- **Retries** failed deliveries with exponential backoff for about a day, then keeps them as dead letters you can replay.
- **Signs** every message with HMAC-SHA256 so receivers can verify it came from you.
- **Records** every attempt, so you can see exactly what was sent and what the receiver answered.

> 🚧 Under construction. Exam project for Chas Academy, *Avancerad fullstackutveckling, test och DevOps*. Oral defense on 4 Nov 2026.

## Addresses

| Service | Address | Status |
|---|---|---|
| API | https://api.myrelay.tech | In progress |
| Dashboard (static files) | https://cdn.myrelay.tech | Planned |
| Metrics and logs | https://grafana.myrelay.tech | Planned |

## Stack

Bun + TypeScript · PostgreSQL (also the job queue, via `SKIP LOCKED`) · k3s on our own VPS ·
Traefik + cert-manager (Let's Encrypt) · GitHub Actions → GHCR · Prometheus, Grafana, Loki ·
Terraform for the backup bucket and cluster add-ons.

## Team

- **Devinder Singh**: backend and infrastructure
- **Abdikhani Mohamed**: frontend and quality

How to run it locally, the architecture diagram, the test strategy and load-test results will
be added as the project is built.
