# 0004. Our container images on GHCR are public

- **Status:** Accepted
- **Date:** 2026-10-29
- **Decided by:** Devinder Singh and Abdikhani Mohamed (asked for in the review of #12)

## Context

At every deploy, k3s on our VPS downloads ("pulls") our images from GHCR. A private image
needs a login: a GitHub token stored in the cluster. Our repository is public, so the code,
the Dockerfile and the lockfile that go into the image are already visible to everyone.

Checked on 29 Oct: the package `relay-api`, published by our pipeline from this public repo,
was public from the start. An anonymous pull of `relay-api:<commit>` answers 200, while a
package that doesn't exist answers 403.

## Decision

Our images (`relay-api`, later `relay-dashboard`) stay **public**, and the cluster pulls them
without credentials.

**The rule that comes with it:** an image may only contain what is already public in the repo:
our code, its dependencies and the base image. Never secrets, `.env` files, keys, or config
with passwords. Settings arrive at runtime, as environment variables and Kubernetes Secrets.
`.dockerignore` keeps `.env*` and the tests out, and only CI builds images, from a reviewed
commit on `main`.

| Not chosen | Why |
|---|---|
| A private image + an `imagePullSecret` | It needs a GitHub token with `read:packages` stored as a Secret in namespace `relay` and referenced by every pod. That's a long-lived credential to rotate and protect, and the `deployer` account can't create Secrets, so an admin would manage it by hand. It would hide nothing that the public repo doesn't already show |
| Docker Hub | Anonymous pulls are rate-limited. GHCR sits next to our repo, and the pipeline logs in with the built-in `GITHUB_TOKEN` |

## Consequences

- No pull secret in the cluster: one credential fewer to create, rotate or leak.
- Anyone can pull and inspect our images. That's fine only while they contain nothing secret,
  so the rule above is a hard rule: every Dockerfile change is reviewed against it.
- If an image ever has to contain something that isn't public, this decision is revisited for
  that image (private, with a pull secret).
- Check that the package is still public, without needing a tag that exists. A public package
  answers with its tag list; a private (or missing) one answers `DENIED`. Keep the two parts
  joined with `&&`, so the second never runs without a token:

```bash
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:devinder-dev/relay-api:pull&service=ghcr.io" | jq -r .token) && \
  curl -s -H "Authorization: Bearer $TOKEN" https://ghcr.io/v2/devinder-dev/relay-api/tags/list
```
