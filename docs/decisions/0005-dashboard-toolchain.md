# 0005. Dashboard toolchain: npm, Node 24.22.1, oxlint

- **Status:** Proposed
- **Date:** 2026-10-31
- **Decided by:** Devinder Singh and Abdikhani Mohamed

## Context

[Decision 0002](0002-dashboard-stack.md) records what the dashboard is built *from* (Vite,
React, TypeScript, Tailwind, React Router). It says nothing about what *builds and checks* it,
and that gap showed up in the review of #9: the choices were already made in the code without
being written down anywhere, so neither of us could point at a reason for them.

The rest of the project runs on **Bun 1.4.4**, pinned on the laptops, in CI and in Docker. The
dashboard is the one part that does not. It is a small single-page app, built once per deploy
into static files that nginx serves; Node never runs in the finished container. Its Playwright
e2e tests also live in this folder and run in CI.

Everything else in the project is pinned to an exact version (Bun 1.4.4, `postgres:18.6`,
k3s v1.36.5), so the toolchain should be too.

## Decision

| Part | Choice | Not chosen, and why |
|---|---|---|
| Package manager | **npm** (`npm ci`, `package-lock.json`) | *Bun:* one runtime for the whole project would be tidier, and it is what we use everywhere else. But this folder's tools are built for Node: Vite's own `engines` field names Node versions (`^20.19.0 \|\| >=22.12.0`), and Playwright is documented and released against Node. Running them on Bun means relying on its Node compatibility layer for the two tools that decide whether the dashboard builds and whether the e2e tests are trustworthy. That is a real risk for no gain: `npm ci` plus a 330 ms Vite build is not what slows us down. |
| Node version | **24.22.1**, pinned in `dashboard/.nvmrc` and `node:24.22.1-alpine` | *Node 26:* became the active LTS on 28 Oct 2026, three days before this record. Our rule is to prefer releases at least two weeks old, and the week of a defense is the wrong time to be early. *Node 22:* in maintenance a year longer and end-of-life Apr 2027, so it buys nothing and expires sooner. 24 is in maintenance — security and bug fixes, no new features — until Apr 2028, and it is the version on Devinder's laptop, which is what we agreed so that we are not debugging a version difference between us. |
| Linter | **oxlint 1.89.0** | *ESLint:* a much larger rule and plugin ecosystem, but it needs its own config file and a typed-lint setup before most of that is reachable, and it is slow enough on every save that in practice we would stop running it. A linter nobody runs finds nothing. oxlint is the `create-vite` default, needs no config, and is fast enough to stay on. If we later want a specific rule oxlint lacks, adding ESLint is its own decision rather than a reason to start there. |

Node's release lines, for the version row above (from `nodejs/Release`, checked 31 Oct 2026):

| Node | Status on 31 Oct 2026 | Supported until |
|---|---|---|
| 22 | maintenance since 21 Oct 2025 | 30 Apr 2027 |
| **24** | **maintenance since 20 Oct 2026** | **30 Apr 2028** |
| 26 | active LTS since 28 Oct 2026 | 30 Apr 2029 |

## Consequences

- The project has **two runtimes**: Bun for `api/` and the worker, Node for `dashboard/`. Each
  folder says which, so neither of us has to remember: `api/.bun-version` and
  `dashboard/.nvmrc`.
- `dashboard/` has its own lockfile (`package-lock.json`) and its own CI cache, separate from
  the API's `bun.lock`.
- The dashboard image is a two-stage build: `node:24.22.1-alpine` compiles, and the result is
  copied into `nginxinc/nginx-unprivileged`. **Node is not in the running container**, so a
  Node CVE is a build-time concern, not a production one.
- `nvm use` inside `dashboard/` picks up `.nvmrc`. Worth setting `nvm alias default 24.22.1`
  as well: without a default, a new shell falls back to whatever Node the system has, and a
  system Node older than Vite's `^20.19.0 || >=22.12.0` fails in a way that looks like a
  broken checkout rather than a wrong Node. That happened on 31 Oct 2026.
- `package.json` has **no `engines` field** today, so npm installs happily on a Node version
  Vite will then refuse. Adding `engines` would turn that into one clear error at install
  time. Worth doing when the dashboard enters CI.
- Node 24 leaves support in **April 2028**, well past the exam, so no upgrade is needed for
  this project. The choice is worth revisiting if the repo outlives it.

## Still to decide

The dashboard is not in CI yet. When it is (step 5.2), the workflow should run `tsc -b`,
`oxlint` and the Playwright tests on Node 24.22.1, so that neither laptop is the authority on
whether the dashboard builds.
