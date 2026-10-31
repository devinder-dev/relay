# 0005. Dashboard toolchain: npm, Node 24.22.1, oxlint

- **Status:** Accepted
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
| Package manager | **npm** (`npm ci`, `package-lock.json`) | npm is what this folder already has: `create-vite` generated the `package-lock.json`, `npm ci` installs exactly what that file pins, and it is the workflow we both already know. The Node *version* row below is a separate decision — Vite's and Playwright's requirements are about Node, not about npm. *Bun:* one runtime for the whole project would be tidier, and it is what we use everywhere else. But this folder's tools are built for Node: Vite's own `engines` field names Node versions (`^20.19.0 \|\| >=22.12.0`), and Playwright is documented and released against Node. Running them on Bun means relying on its Node compatibility layer for the two tools that decide whether the dashboard builds and whether the e2e tests are trustworthy. That is a real risk for no gain: `npm ci` plus a 330 ms Vite build is not what slows us down. |
| Node version | **24.22.1**, pinned in `dashboard/.nvmrc` and `node:24.22.1-alpine` | *Node 26:* became the active LTS on 28 Oct 2026, three days before this record. We stay on the Node 24 line the dashboard is already built and tested on: a major Node version is the kind of change that moves Vite's and Playwright's own supported ranges, and those two tools decide whether the dashboard builds and whether the e2e tests mean anything. The week of a defense is the wrong time to find that out, so 26 is a move for after the exam, not before it. *Node 22:* in maintenance a year longer and end-of-life Apr 2027, so it buys nothing and expires sooner. 24 is in maintenance — security and bug fixes, no new features — until Apr 2028, and it is the version on Devinder's laptop, which is what we agreed so that we are not debugging a version difference between us. |
| Linter | **oxlint 1.89.0** | *ESLint:* a much larger rule and plugin ecosystem, and many of its rules work without a typed-lint setup. We have not measured it against oxlint, so speed is not our argument. The reason is narrower: oxlint is the linter `create-vite` scaffolds, it covers the checks we want with a small config, and we have not yet needed a rule that only ESLint has. If we do, adding ESLint is its own decision rather than a reason to start there. |

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
  copied into `nginxinc/nginx-unprivileged`. **Node never runs in production.** A Node CVE is
  therefore a build-time concern rather than a running-container one — but not a harmless one:
  a compromised build step could change the files it produces, and those files are exactly what
  users are served.
- `nvm use` inside `dashboard/` picks up `.nvmrc`. Worth setting `nvm alias default 24.22.1`
  as well: without a default, a new shell falls back to whatever Node the system has, and a
  system Node older than Vite's `^20.19.0 || >=22.12.0` fails in a way that looks like a
  broken checkout rather than a wrong Node. That happened on 31 Oct 2026.
- `package.json` has **no `engines` field** today, so npm installs happily on a Node version
  Vite will then refuse. Adding `engines` on its own would not change that: npm's
  `engine-strict` is `false` by default, so `engines` only prints a warning. Turning it into a
  real failure takes `engines` **plus** `engine-strict=true` in `dashboard/.npmrc`. We have
  not done either, on purpose: CI pins Node from `.nvmrc`, which is the guard that decides
  whether the dashboard builds, and `engine-strict` would only protect a local `npm install`
  on the wrong Node.
- Node 24 leaves support in **April 2028**, well past the exam, so there is no *major* upgrade
  to make before then; patch releases on the 24 line still apply as normal. The choice is
  worth revisiting if the repo outlives the course.

## In CI

The `dashboard-test` job runs on every pull request. It reads the Node version from
`dashboard/.nvmrc`, so CI, Docker and both laptops take it from one file, then runs `npm ci`,
`npm run lint`, `npm run build` and the Playwright e2e tests. The build step is there on
purpose: Playwright drives Vite's dev server, so only `npm run build` proves the production
build still works.

The `dashboard-image` job then builds the two-stage image, smoke-tests it, and on `main`
pushes `ghcr.io/devinder-dev/relay-dashboard:<sha>`, so the tag exists for every commit the
deploy might apply. Neither laptop is the authority on whether the dashboard builds.
