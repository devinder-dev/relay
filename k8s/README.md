# Kubernetes manifests

How each folder gets onto the cluster, and who may apply it.

| Folder | What's in it | Applied by |
|---|---|---|
| `k8s/platform/` | Cluster setup: Let's Encrypt issuers, Traefik settings, the `relay` namespace and the `deployer` account | One of us, by hand, after the PR is reviewed |
| `k8s/app/` (from step 1.7) | Our app in namespace `relay`: Deployments, Services, Ingresses, ConfigMaps | Only the pipeline, through `relay-deploy` |
| `k8s/hello/` | The temporary hello-world test app | By hand. Removed when the API takes over in step 1.7 |

## Rules

- **Platform files are never applied by the pipeline.** They decide who may do what, so a
  person applies them after review. Otherwise the pipeline could widen its own rights.
- **`k8s/app/` holds only what the `deployer` account may change:** Deployments, Services,
  Ingresses and ConfigMaps. A Namespace or a Secret there would make the deploy fail with
  "forbidden".
- **Images in `k8s/app/` use the tag `__GIT_SHA__`.** `relay-deploy` replaces it with the
  commit it deploys, so manifests and image always come from the same commit. Don't apply
  these files by hand: the tag would be wrong.
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
                      wait for the rollout, or undo it if it fails
                        │ every kubectl call uses the "deployer" account:
                        │ namespace relay only, no Secrets
                        ▼
       Deployment relay-api runs the new pods
```

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
