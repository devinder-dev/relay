# 0002. Dashboard stack: Vite, React, Tailwind, React Router, axios

- **Status:** Accepted
- **Date:** 2026-10-25
- **Decided by:** Devinder Singh and Abdikhani Mohamed

## Context

The Relay dashboard is a small single-page app on `https://cdn.myrelay.tech`, served as static
files. It has four screens (Connect, Delivery Log, Delivery Detail with Replay, Endpoints) and
talks to `https://api.myrelay.tech` with the owner's API key. The Delivery Detail screen should
update by itself while a delivery is pending, so the live demo can show retries happening.

Both of us know HTML, CSS, Tailwind, React, TypeScript, fetch and axios. We are examined
individually, so the code must be easy for both of us to read and explain.

## Decision

| Part | Choice | Not chosen, and why |
|---|---|---|
| Build tool | **Vite** + React + TypeScript | Next.js: adds a server; the brief wants static files on `cdn.` |
| Styling | **Tailwind CSS v4** (`@tailwindcss/vite`) | Plain CSS: fine, but we both know Tailwind and it keeps spacing and colours consistent |
| Pages | **React Router** | Hand-made screen switching: no real URLs, so `/deliveries/:id` can't be shared or reloaded |
| API calls | **axios**, one shared client in `src/api.ts` | `fetch`: also fine, but axios reads more clearly to us (base URL, auth header and error handling set once) |
| Server data | **Plain React state** (`useState` + `useEffect`), with a small refresh loop on the detail screen while a delivery is pending | TanStack Query: powerful, but adds concepts we don't need for four screens |
| Serving | **nginx** (unprivileged image) with the built files | — |

## Consequences

- `src/api.ts` is the only file that talks to the API. It creates one axios client with
  `baseURL` from `VITE_API_URL`, a timeout, and an interceptor that adds
  `Authorization: Bearer <key>` (the key is kept in `sessionStorage`).
- The detail screen reloads every 2 seconds only while the delivery is `pending`, and stops when
  it leaves the page. Replay triggers one reload.
- nginx must send unknown paths to `index.html`, so reloading `/deliveries/:id` works with
  React Router.
- The API must allow CORS from `https://cdn.myrelay.tech` (and localhost in CI).
- The backend keeps using `fetch` in the worker to deliver webhooks: it needs
  `redirect: "manual"` and `AbortSignal.timeout()`, and runs on the server, not in the browser.
