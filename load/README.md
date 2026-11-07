# Load tests (Phase 8)

[`relay.js`](relay.js) runs against the deployed API with [k6](https://k6.io). It is the load
generator for the autoscaler's evidence (VG3) and for the capacity numbers in the project README.

k6 is not installed: it runs from its official image, so there is nothing to add to either laptop
and the version is pinned like every other image we use.

The pin is **1.8.2** (released 24 Oct 2026, so past our two-week rule for new releases). `2.3.0`
came out the same day and would also qualify on age, but it is a new major line and there is no
reason to take that change two days before submission. Whichever we move to later, pin it: an
unpinned `latest` means a load test that cannot be repeated.

## Running it

The daemon has to be up first (`sudo systemctl start docker`, on its own because it asks for a
password). Then, from the repository root:

```sh
docker run --rm -i grafana/k6:1.8.2 run - < load/relay.js
```

That runs the default scenario, `health`: 20 virtual users against `GET /health/live` for two
minutes. No key, no database, nothing written.

The reads scenario needs an API key. Export it first so it never appears in the command line or
in the shell's history - `-e RELAY_KEY` with no value passes it from the environment:

```sh
export RELAY_KEY='relay_live_…'
docker run --rm -i -e SCENARIO=read -e RELAY_KEY grafana/k6:1.8.2 run - < load/relay.js
```

| Variable | Default | What it does |
|---|---|---|
| `SCENARIO` | `health` | `health` or `read` |
| `RELAY_KEY` | empty | Required by `read`; the script refuses to start without it |
| `RELAY_BASE` | `https://api.myrelay.tech` | Point it elsewhere to test a local API |
| `VUS` | 20 (`health`), 5 (`read`) | Virtual users. The autoscaler run needs about 80, see below |
| `DURATION` | 2m (`health`), 1m (`read`) | k6 duration, e.g. `30s`, `5m` |

k6 exits **99** when a threshold fails, so this is a test and not just a report. A failing run is
supposed to fail the command.

## The thresholds, and where they came from

| Scenario | Failures | p(95) | Based on |
|---|---|---|---|
| `health` | `rate<0.001` | `150 ms` | Two runs on 7 Nov 2026: 53,224 requests, **0 failed**, p(95) 62-63 ms, max 158 ms |
| `read` | `rate<0.001` | `300 ms` | **Reasoning, not a measurement** - see below |

`health`'s ceiling is about 2.4x the measured figure, which absorbs a bad network minute while
still catching the API's own work doubling. Roughly 50 ms of each request is network from a
laptop, so it guards against regression rather than proving absolute speed.

`read` has **not been measured**: it needs an API key, so it has no baseline yet. Its 300 ms is
loose on purpose, because the database holds a handful of rows today and any number measured now
would say little about a loaded one. It is not a claim that a page takes 300 ms; it is a claim
that a page should never take seconds, which is what a missing index on a grown `deliveries`
table would look like. Take a baseline and tighten it:

```sh
export RELAY_KEY='relay_live_…'
docker run --rm -i -e SCENARIO=read -e DURATION=30s -e RELAY_KEY grafana/k6:1.8.2 run - < load/relay.js
```

## What it does not do

**No scenario posts events.** At load that would create thousands of real events and deliveries in
production, and retries against whatever endpoints exist at the time. Adding one needs agreeing
first, and its own owner and endpoint so it cannot flood a real customer's.

**The load comes from one laptop**, over the public internet, so a large share of each
measurement is network rather than Relay. That is the same limitation as the ApacheBench runs
already recorded in the project README, and it has to be said next to any number from here.

**`health` touches no database.** It measures how the API and the autoscaler behave under HTTP
load, not how much work Relay can get through. The `read` scenario is the one that reaches
Postgres.

## Using it for the autoscaler (VG3)

The autoscaler scales on CPU at 70% of the API's request (`100m`, so `70m`). Idle, the API sits at
about `1m` - roughly 1% - so nothing moves without load. Run `health` in one terminal and watch
the pod count in another:

```sh
ssh relay 'while sleep 5; do echo "$(date -u +%T) $(kubectl --kubeconfig $HOME/.kube/config -n relay get hpa relay-api --no-headers)"; done'
```

Keep that loop running after k6 stops, until the count is back to 2: scaling **down** is part of
what VG3 asks for, and it takes about five minutes of calm plus a minute per pod. Save
`kubectl -n relay describe hpa relay-api` straight afterwards - its events are the autoscaler
explaining its own decisions - and report the measured time to scale rather than an estimate.

**The default 20 users is not enough to scale anything.** Measured on 7 Nov 2026: 20 users gave
45,732 requests in two minutes, 0 failed, p(95) 63 ms - and a peak of only **51m of CPU per pod**,
below the 70m the autoscaler needs. The test is latency-bound (20 users x 52 ms round trip is
about 380 requests a second), so each request costs the API almost nothing.

For the autoscaler to settle at four pods, each of the four has to exceed 70m, so over 280m in
total against the ~102m that 20 users produced - roughly 2.75x. Use about 80:

```sh
docker run --rm -i -e VUS=80 -e DURATION=5m grafana/k6:1.8.2 run - < load/relay.js
```

Five minutes rather than two: long enough to scale up, hold at four and show it is stable rather
than a spike. Bandwidth is not the constraint - the whole 20-user run moved 7 MB - so this is
about connection concurrency on the laptop.
