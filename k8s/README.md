# Kubernetes manifests

How each folder gets onto the cluster, and who may apply it.

| Folder | What's in it | Applied by |
|---|---|---|
| `k8s/platform/` | Cluster setup: Let's Encrypt issuers, Traefik settings, the `relay` namespace (with its Pod Security level), the `deployer` account, the Service policy for `relay`, the worker's NetworkPolicy, the API's autoscaler and the StorageClass `local-path-retain` | One of us, by hand, after the PR is reviewed |
| `k8s/monitoring/` | Metrics and logs (Phase 7): Helm values for kube-prometheus-stack, Loki and Alloy, in namespace `monitoring` | One of us, by hand with Helm, after the PR is reviewed. **Never the pipeline**: it installs CRDs and cluster-wide roles, which the `deployer` account cannot do, and Helm cannot reach the cluster from CI because 6443 is closed. See [`monitoring/README.md`](monitoring/README.md) |
| `k8s/data/` (from step 2.3) | Postgres: its Service and StatefulSet (`postgres.yaml`) and its first-start script (`initdb/`). The daily backup CronJob (`backup-cronjob.yaml`) and temporary restore Pod (`restore-drill.yaml`, only during a drill) | One of us, by hand, after the PR is reviewed. **Never the pipeline**: the `deployer` account can't create StatefulSets, Secrets or CronJobs, so a merged PR can't change the database's version or its disk. Backups must not change with app deploys; apply the drill file separately and delete its Pod afterwards. Order and recovery: [`infra/server/README.md`](../infra/server/README.md), section 6 |
| `k8s/migrate/` (from step 2.4) | The migrate Job: runs the commit's database migrations (dbmate) once per deploy | Only `relay-deploy`, with `kubectl create` (never `apply`: every deploy gets a fresh Job name), **before** `k8s/app/`. Kubernetes deletes finished Jobs after 1 hour, because the `deployer` account can't delete |
| `k8s/app/` (from step 1.7) | Our app in namespace `relay`, the API, dashboard, worker and demo receiver: Deployments, Services, Ingresses, ConfigMaps | Only the pipeline, through `relay-deploy` |

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
- **Two guards on namespace `relay`**, checked by the API server before anything is saved,
  whoever sends it (the pipeline or one of us):
  - **Pod Security `restricted`** (labels in `deployer.yaml`): no pod runs as root,
    privileged, or with host folders, network or ports. Every pod spec needs
    `runAsNonRoot`, `allowPrivilegeEscalation: false`, `capabilities: drop: ["ALL"]` and the
    `RuntimeDefault` seccomp profile, as `k8s/app/deployment.yaml` shows.
  - **Services stay inside the cluster** (`relay-service-policy.yaml`): only type ClusterIP
    (headless included), never `externalIPs`. ufw can't filter ports that Kubernetes
    publishes, so nothing in `relay`, and above all Postgres, may publish one.
  - **What the guards don't cover**, on purpose, so we know it rather than find out:
    1. The Service policy only sees **Services**. A Traefik `IngressRouteTCP` could publish
       a TCP port without one. We have none, and only an admin could create one.
    2. Both guards only cover **`relay`**. A NodePort Service in another namespace, pointed at
       a `relay` pod's IP by hand, would still reach that pod from outside.

    The `deployer` account can do neither: it is confined to `relay` and has no rights on
    Traefik's own objects. Both need an admin doing it deliberately.
- **The issuers' challenge Services are ClusterIP** (`cluster-issuers.yaml`). cert-manager's
  default is NodePort, which the Service policy would refuse in `relay`. Apply the issuers
  before the policy.
- **No Secrets in git.** They are created on the server with `kubectl create secret`.
- **Git and the cluster must match.** Everything applied by hand is committed in the same PR.

## Worker

The worker starts at **0 replicas**. Before it runs, an administrator applies
`k8s/platform/worker-egress.yaml` and checks the worker's allowed and blocked connections.
A separate one-line PR then changes the worker to 2 replicas. Rolling that activation back
restores 0: the deployer can update a Deployment but cannot delete a newly added one.

Before the receiver is deployed, an administrator creates the demo endpoint and makes Secret
`relay-demo-receiver`, key `signing_secret`, from the signing secret the API shows once.
The Secret is never in git; the receiver cannot start without it.

The worker's production manifest temporarily uses the short exam demo retry schedule
`5s,30s,2m,10m`: 5 tries, about 13 minutes of waits. The code default stays 8 tries over about
21 hours. Change the demo setting deliberately after grading.

**Stop switch (admin only):** `kubectl -n relay scale deployment/relay-worker --replicas=0`.
The next deploy restores what git says, so follow a lasting manual stop with a PR.

## The API's autoscaler

`k8s/platform/api-hpa.yaml` decides how many API pods run: 2 when idle, up to 4 when the average
pod uses more than 70% of its CPU request (100m, so 70m). It is a platform file because the
pipeline's account cannot create or change autoscalers, so a merged PR can never widen or remove
these limits.

`k8s/app/deployment.yaml` therefore has **no `replicas:` field**, and must not get one back:
every deploy would overwrite whatever the autoscaler had decided.

**Why `replicas:` cannot simply be deleted.** `kubectl apply` removes a field that it applied
last time and no longer sees, so the first deploy after that merge would set the count to **1**.
Measured, not assumed: with the live Deployment running 2 pods,
`apply --dry-run=server -o jsonpath={.spec.replicas}` on the field-less manifest answered `1`.
The autoscaler would repair it, but not instantly - its 15 s sync, then a new pod starting and
passing readiness, so 20-40 s on a single pod, and at the same moment a new image is rolling out.
For a project graded on zero downtime, better that it never happens.

**So remove the field from kubectl's memory first**, the migration path in Kubernetes' own HPA
documentation. Run this on the server **immediately before merging**, with no other merge in
between - every deploy re-applies `replicas: 2` and puts it back in the annotation:

```sh
kubectl -n relay get deploy relay-api \
  -o jsonpath='{.metadata.annotations.kubectl\.kubernetes\.io/last-applied-configuration}' > ~/la-before.json
jq 'del(.spec.replicas)' ~/la-before.json > ~/la-after.json
diff <(jq -S . ~/la-before.json) <(jq -S . ~/la-after.json)   # must show only replicas
kubectl -n relay apply set-last-applied -f ~/la-after.json    # changes only the annotation
kubectl -n relay get deploy relay-api -o jsonpath='{.spec.replicas}'   # still 2
```

`jq` is on the server (1.8.1, checked). Without it, `kubectl -n relay apply edit-last-applied deployment/relay-api` does
the same in an editor; run it on its own, since it asks questions. Neither file holds a secret:
the Deployment's env uses `secretKeyRef`, so only the reference is in the annotation.

Afterwards `apply --dry-run=server -o jsonpath={.spec.replicas}` answers **2**, and the count
never drops.

**The full order:**

1. Apply `k8s/platform/api-hpa.yaml`. Nothing changes: it holds the count at 2.
2. Load test and record the numbers, with no merges during the window.
3. Clean the annotation, as above.
4. Merge, and check `kubectl -n relay get deploy relay-api` never left 2.

**Two things that put `replicas: 2` back.** A failed deploy of that PR makes `relay-deploy` roll
back to the commit before it, which applies `replicas: 2` again and restores it in the annotation
- as does any manual rollback to a commit from before the change. Repeat step 3 before deploying
forward again. And while the autoscaler is applied but the PR is not yet merged, any *other*
merge re-applies `replicas: 2` and resets the pod count, which is why the load test needs an
agreed window.

**On a rebuild**, apply the autoscaler before the app manifests: a Deployment created with
neither a `replicas:` field nor an autoscaler starts with one pod.

**Checking it:** `kubectl -n relay get hpa` shows the current and target CPU and the pod count.
It needs metrics-server, which k3s runs by default; `kubectl -n relay top pods` proves it is
answering. With no load the API sits at about 1% of its request, so the count stays at 2 until
something pushes it.

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
