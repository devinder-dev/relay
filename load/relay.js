// Load tests for Relay's API, run with k6.
//
// Two scenarios, chosen with SCENARIO:
//
//   health  GET /health/live   no key, no database. This is the one that drives the
//                             autoscaler: 20 users for two minutes, the same shape as the
//                             ApacheBench runs already recorded in the README, so the
//                             numbers are comparable.
//   read    GET /v1/deliveries  needs a key. Every request reaches Postgres, so this is a
//                             realistic dashboard read rather than the most the box can take.
//
// There is deliberately no scenario that posts events. At load that would create thousands of
// real events and deliveries in production, and retries against whatever endpoints exist.
// Adding one needs agreeing first, and its own owner and endpoint.
//
// How to run it is in load/README.md.
import http from 'k6/http'
import { check } from 'k6'

const BASE = __ENV.RELAY_BASE || 'https://api.myrelay.tech'
const KEY = __ENV.RELAY_KEY || ''
const SCENARIO = __ENV.SCENARIO || 'health'

// The defaults are the shape to quote as "the load test". VUS and DURATION override them
// without editing this file, which is what the autoscaler run needs: 20 users is latency-bound
// at about 380 requests a second and only reaches ~51m of CPU per pod, below the autoscaler's
// 70m target, so it would show no scaling at all. Measured 7 Nov: 45,732 requests, 0 failed,
// p(95) 63 ms, peak 51m per pod. Reaching four pods needs roughly 80 users.
const defaults = {
  health: { vus: 20, duration: '2m' },
  read: { vus: 5, duration: '1m' },
}
const shapes = Object.fromEntries(
  Object.entries(defaults).map(([name, shape]) => [
    name,
    {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || shape.vus),
      duration: __ENV.DURATION || shape.duration,
      exec: name,
    },
  ]),
)

// ---------------------------------------------------------------------------------------------
// YOUR PART. What counts as fast enough and reliable enough for Relay?
//
// k6 fails the run (exit code 99) if a threshold is not met, which is what makes this a test
// rather than a report. Each entry is `'metric': ['expression', ...]`. The ones worth using:
//
//   http_req_failed      a rate, 0 to 1. Requests that did not get a 2xx or 3xx.
//                        e.g. 'rate<0.01'  = under 1% failed
//   http_req_duration    a duration in ms, with p(95), p(99), avg, max.
//                        e.g. 'p(95)<500'  = 95% of requests answered inside 500 ms
//   checks               a rate. The check() calls below.
//                        e.g. 'rate>0.99'
//
// Two things to think about rather than copying a number from a blog post:
//
//   - `health` answers from memory with no database, over the public internet from one laptop.
//     Most of its time is network, not Relay. A tight p(95) here measures the café wifi.
//   - `read` joins three tables and is paged. It should be slower, and its ceiling says what a
//     dashboard user would put up with - which is a product decision, not a technical one.
//
// Be ready to defend the numbers: an examiner can reasonably ask "why 500 and not 200?"
const thresholds = {
  health: {
    // Zero failures in 53,224 requests across two runs on 7 Nov. At 1% this would allow 532
    // failures and never fire; 0.1% still allows 53, so it tolerates a bad moment without
    // being decorative.
    http_req_failed: ['rate<0.001'],
    // Measured p(95) 62-63 ms over two runs, max 158 ms. 150 is about 2.4x the measured
    // figure: enough headroom for a bad network minute, tight enough to catch the API's own
    // work doubling. Worth being honest about what this measures - roughly 50 ms of it is
    // network from a laptop, so it guards against regression rather than proving speed.
    http_req_duration: ['p(95)<150'],
    // Both checks, not just the status: a 200 carrying the wrong body should still fail.
    checks: ['rate>0.999'],
  },
  read: {
    // NOT MEASURED YET. These come from reasoning, not from a run, because the scenario needs
    // an API key. Take a baseline (`SCENARIO=read VUS=5 DURATION=30s`) and tighten them.
    //
    // A 503 here is the API unable to reach Postgres, which is exactly what this should catch,
    // so the failure budget stays as strict as the health one.
    http_req_failed: ['rate<0.001'],
    // Deliberately loose at 300 ms, for a reason worth saying out loud: the database holds a
    // handful of rows today, so any number measured now says little about a loaded one. This
    // is not "a page should take 300 ms" - it is "a page should never take seconds", which is
    // what a missing index on a grown `deliveries` table would look like.
    http_req_duration: ['p(95)<300'],
    checks: ['rate>0.999'],
  },
}
// ---------------------------------------------------------------------------------------------

if (!shapes[SCENARIO]) {
  throw new Error(`SCENARIO must be one of: ${Object.keys(shapes).join(', ')}`)
}
if (SCENARIO === 'read' && !KEY) {
  throw new Error('SCENARIO=read needs RELAY_KEY (see load/README.md)')
}
if (__ENV.VUS && !Number.isInteger(Number(__ENV.VUS))) {
  throw new Error(`VUS must be a whole number, got "${__ENV.VUS}"`)
}

export const options = {
  scenarios: { [SCENARIO]: shapes[SCENARIO] },
  thresholds: thresholds[SCENARIO],
  // Relay's certificate is from Let's Encrypt, so never skip verification: a load test that
  // ignores TLS would also pass against something that is not us.
  insecureSkipTLSVerify: false,
}

export function health() {
  const res = http.get(`${BASE}/health/live`, { tags: { name: 'health/live' } })
  check(res, {
    'status is 200': (r) => r.status === 200,
    'says ok': (r) => r.json('status') === 'ok',
  })
}

export function read() {
  const res = http.get(`${BASE}/v1/deliveries?limit=50`, {
    headers: { Authorization: `Bearer ${KEY}` },
    tags: { name: 'v1/deliveries' },
  })
  check(res, {
    'status is 200': (r) => r.status === 200,
    // A 200 with a body that is not a page would still count as success without this.
    'answers a page': (r) => Array.isArray(r.json('data')),
  })
}
