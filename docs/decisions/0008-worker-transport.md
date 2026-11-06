# 0008. Worker transport: a checked address pinned to one connection

- **Status:** Accepted
- **Date:** 2026-11-06
- **Decided by:** Devinder Singh and Abdikhani Mohamed

## Context

A webhook URL can resolve to a public address during validation, then a private address when
connected. Checking twice alone leaves this DNS rebinding gap. ADR 0002 proposed fetch for the
worker; this decision replaces that transport choice.

## Decision

Use node:https (node:http only for exact operator-approved HTTP origins), resolve and validate
every address, then supply the first checked address through a pinned lookup callback.
Keep the original hostname for Host and TLS certificate verification. Use agent: false so a
previous connection cannot bypass this lookup. Never follow redirects. DNS and HTTP share one
ten-second absolute deadline; response excerpts are bounded to 1024 bytes.

The 6 November Bun 1.4.4 probes showed the pin reaching loopback when requested, and a wrong-host
certificate failing hostname validation. Default-agent reuse bypassed lookup in the negative
control. Local TLS tests preserve these checks without internet or disabled verification.

## Alternatives and consequences

Fetch needs less code, but does not provide the pinned lookup control this design needs.
Node's request API adds explicit lifecycle and response-stream handling, which must be tested.
The worker's administrator-managed NetworkPolicy is a second layer; this code-only release
does not install or claim to verify that policy. Endpoint creation retains DNS-free exact-origin
exceptions so an internal Service can be registered before it exists; sending always resolves.

The operator allow-list (`SSRF_ALLOW_ORIGINS`) is global: any owner can register an endpoint
at exactly the demo receiver's origin, and Relay will POST there over plain HTTP inside the
cluster. We accept this deliberately. Customers cannot change the list; its only target is our
own demo receiver, which accepts only signatures made with the demo endpoint's key (others get
401). Scoping the list per owner would bring an owner concept into the SSRF layer that nothing
else needs. After grading, we empty the list and remove the receiver.
