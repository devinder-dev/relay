# Kubernetes manifests

How each folder gets onto the cluster, and who may apply it.

| Folder | What's in it | Applied by |
|---|---|---|
| `k8s/platform/` | Cluster setup: Let's Encrypt issuers, Traefik settings, the `relay` namespace and the `deployer` account | One of us, by hand, after the PR is reviewed |
| `k8s/app/` (from step 1.7) | Our app in namespace `relay`, the API and the dashboard: Deployments, Services, Ingresses, ConfigMaps | Only the pipeline, through `relay-deploy` |
| `k8s/hello/` | The temporary hello-world test app | By hand. Removed when the API takes over in step 1.7 |

## Rules

- **Platform files are never applied by the pipeline.** They decide who may do what, so a
  person applies them after review. Otherwise the pipeline could widen its own rights.
- **`k8s/app/` holds only what the `deployer` account may change:** Deployments, Services,
  Ingresses and ConfigMaps. A Namespace or a Secret there would make the deploy fail with
  "forbidden".
- **Images in `k8s/app/` use the tag `__GIT_SHA__`** (`relay-api` and `relay-dashboard`
  alike). `relay-deploy` replaces it with the commit it deploys, so manifests and images
  always come from the same commit. That's why every merge to main builds every image, even
  the ones that didn't change: the tag must exist for each commit. Don't apply these files
  by hand: the tag would be wrong.
- **Removing a file from `k8s/app/` doesn't remove it from the cluster.** The `deployer`
  account has no delete, so one of us deletes the resource by hand:
  `kubectl -n relay delete <kind>/<name>`. **Renaming is the dangerous case:** the new name is
  created, but the old object stays and keeps serving (two Services or two Ingresses for the
  same thing). A rename = the new name in the PR, plus deleting the old object right after it
  merges.
- **Server and platform changes are applied by the one who merges, right after merging**, and
  the check output is posted on the PR (for example `auth can-i` and the script `diff`).
  Otherwise git and the server drift apart, and it only shows when something fails.
- **No Secrets in git.** They are created on the server with `kubectl create secret`.
- **Git and the cluster must match.** Everything applied by hand is committed in the same PR.

## Applying a platform file

From the repo root on your laptop. Check first with a server-side dry run (nothing is saved),
then apply:

```bash
ssh relay 'kubectl --kubeconfig ~/.kube/config apply --dry-run=server -f -' < k8s/platform/deployer.yaml
ssh relay 'kubectl --kubeconfig ~/.kube/config apply -f -' < k8s/platform/deployer.yaml
```

## How `k8s/app/` gets applied: the deploy path

```
merge to main ─► GitHub Actions (environment "production", main only)
                  1. test, build, push ghcr.io/devinder-dev/relay-api:<sha>
                  2. ssh deploy@<vps> <sha>
                        │
VPS    Linux user "deploy": its key may only start /usr/local/bin/relay-deploy
                        │
       relay-deploy:  <sha> must be 40 hex characters and part of main's history,
                      then check out that commit, apply k8s/app/ with the tag,
                      and wait until every Deployment is ready.
                      If one isn't: deploy the last good commit again.
                        │ every kubectl call uses the "deployer" account:
                        │ namespace relay only, no Secrets
                        ▼
       the Deployments (API, dashboard) run the new pods
```

**Rollback.** After every successful deploy, `relay-deploy` writes the commit to
`/home/deploy/.relay-last-good`. If a later rollout fails, it deploys that commit again the
same way, so manifests and images go back together. `kubectl rollout undo` would only
revert the pods' image and leave the failed commit's ConfigMaps and Ingresses behind. The
job still turns red after a rollback, because the commit we asked for isn't live. Limit:
a resource that only the failed commit *added* stays, because there's no delete.

The server-side parts live in `infra/server/` and are installed by hand, by an admin:

| File | What it does | Install or update |
|---|---|---|
| `setup-deploy-user.sh` | One time: the `deploy` user, its forced command, the `deployer` kubeconfig, a clone of the repo | `ssh relay 'cat > /tmp/setup.sh' < infra/server/setup-deploy-user.sh`, then `ssh -t relay "sudo bash /tmp/setup.sh '<deploy public key>'"` |
| `relay-deploy.sh` | The only program the deploy key may run | `ssh relay 'cat > /tmp/relay-deploy' < infra/server/relay-deploy.sh`, then `ssh -t relay 'sudo install -o root -g root -m 755 /tmp/relay-deploy /usr/local/bin/relay-deploy'` |

`relay-deploy` is owned by root, so the `deploy` user can run it but not change it. If the
script changes in a PR, install it again after the merge, so the server matches git.

**Deploying by hand** (admins only, for example to redeploy an older commit from main):

```bash
ssh -t relay 'sudo -u deploy env SSH_ORIGINAL_COMMAND=<sha> /usr/local/bin/relay-deploy'
```

**If the deploy key leaks:** delete the `DEPLOY_SSH_KEY` secret in GitHub, empty
`/home/deploy/.ssh/authorized_keys` on the server, then make a new key and run
`setup-deploy-user.sh` again. To cut off the `deployer` account itself, delete the Secret
`deployer-token` in namespace `relay`; its token stops working at once.
