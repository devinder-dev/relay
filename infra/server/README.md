# Rebuilding the server

How to get from a fresh VPS back to a running cluster, in order. Every setting that lives on the
server is in this folder or in `k8s/`. Only the web panels (one.com, get.tech) and GitHub's
settings are outside git.

Copy a file to the server with `ssh relay 'cat > /tmp/<name>' < infra/server/<name>`, then
run the command shown on the server. Commands that ask questions (`adduser`, the first `sudo`)
run alone, never inside a pasted block.

## 1. Outside the server (web panels)

- **one.com:** a VPS with Ubuntu 26.04 (4 vCPU, 8 GB). Two-step login on the account.
- **one.com network firewall:** exactly three rules, IPv4 TCP 22, 80 and 443. No `All` rule
  and nothing for IPv6. ufw can't filter ports that Kubernetes publishes (NodePorts), so this
  firewall is the only thing blocking them. When changing rules, add the new one before
  deleting an old one, so SSH never drops. Check from outside, both ways: 22, 80 and 443 must
  answer AND 30795 must not. A check that only expects a failure can't tell a blocked port from
  a broken command. macOS: `nc -z -G 3 <vps-ip> <port>`; Linux (netcat-openbsd has no `-G`,
  so there it fails before connecting): `nc -z -w 3 <vps-ip> <port>`.
- **get.tech DNS:** A records `api`, `cdn` and `grafana` → the VPS's IPv4 address. No AAAA
  records: the cluster is IPv4-only, and Let's Encrypt prefers IPv6 when it exists.

## 2. Base system (steps 0.3–0.7)

| What | How |
|---|---|
| Personal users | `sudo adduser <name>` (alone), `sudo usermod -aG sudo <name>`, then `ssh-copy-id` from each laptop |
| Updates | `sudo apt update && sudo apt full-upgrade -y`, then `sudo dpkg-reconfigure -plow unattended-upgrades` (daily security updates) |
| SSH | `sudo install -m 644 /tmp/sshd-hardening.conf /etc/ssh/sshd_config.d/00-hardening.conf && sudo sshd -t && sudo systemctl restart ssh`. Test a new login in a second terminal before closing the first |
| Firewall | `sudo bash /tmp/firewall.sh` |

## 3. Kubernetes (steps 0.8–0.11)

| What | How |
|---|---|
| k3s settings | `sudo install -D -m 644 /tmp/k3s-config.yaml /etc/rancher/k3s/config.yaml`, **before** installing k3s |
| k3s v1.36.5 | Download `https://get.k3s.io` to a file, read it, then run it with `INSTALL_K3S_VERSION=v1.36.5+k3s1` |
| kubectl for each admin | `mkdir -p ~/.kube && sudo install -m 600 -o "$USER" /etc/rancher/k3s/k3s.yaml ~/.kube/config`. It's an admin password: never copy it off the server |
| cert-manager v1.21.2 | `kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.21.2/cert-manager.yaml` |
| Platform files | `k8s/platform/*.yaml`, applied by hand (see [`k8s/README.md`](../../k8s/README.md)) |

## 4. The deploy path (step 1.6)

1. `setup-deploy-user.sh` and `relay-deploy.sh`: see [`k8s/README.md`](../../k8s/README.md).
2. GitHub environment `production` (only `main` may use it): the secret `DEPLOY_SSH_KEY`
   (the new key's private half, with `gh secret set … --env production < key`), and the variables
   `DEPLOY_HOST` and `DEPLOY_KNOWN_HOSTS` (the server's new host key).
3. Merge anything to `main` (or re-run the last pipeline): the app deploys itself.

## 5. GitHub settings (not in git; made with `gh`, stored by GitHub)

- Ruleset `protect-main`: PR + 1 approval, approval after the last push, no force-push, no
  deletion. Squash merges only. Required checks `api-test` and `deploy-script-test` (since
  29 Oct). "Approval after the last push" is `require_last_push_approval: true`: an old
  approval stays visible, but a PR can't merge until the newest push is approved.
- Environment `production`: only `main` may use it. Secret `DEPLOY_SSH_KEY`, variables
  `DEPLOY_HOST` and `DEPLOY_KNOWN_HOSTS`.
- GHCR package `relay-api`: public, so the cluster pulls it without a password.

## 6. Data: Postgres (step 2.3; backups in Phase 6)

Postgres runs in namespace `relay` on a disk that is kept even if its claim is deleted
(StorageClass `local-path-retain`). It's applied by hand, never by the pipeline
([`k8s/README.md`](../../k8s/README.md)). From the repo root on the laptop, **in this order**,
each step only after the previous one worked:

| # | What | How | Expected |
|---|---|---|---|
| 1 | The StorageClass | `ssh relay 'kubectl --kubeconfig ~/.kube/config apply -f -' < k8s/platform/storageclass-retain.yaml` | `kubectl get sc` lists `local-path-retain … Retain`, and `local-path` stays the default |
| 2 | The passwords | `ssh relay 'bash -s' < infra/server/bootstrap-secrets.sh` | `created postgres-auth`, `created relay-db` (or `kept …`: it never overwrites) |
| 3 | The first-start script | `ssh relay 'kubectl --kubeconfig ~/.kube/config -n relay create configmap postgres-init --from-file=10-create-relay.sh=/dev/stdin --dry-run=client -o yaml \| kubectl --kubeconfig ~/.kube/config apply -f -' < k8s/data/initdb/10-create-relay.sh` | `configmap/postgres-init created` |
| 4 | Postgres | `ssh relay 'kubectl --kubeconfig ~/.kube/config apply -f -' < k8s/data/postgres.yaml`, then `kubectl -n relay rollout status sts/postgres` | `postgres-0` ready; its log says `10-create-relay.sh: created the login relay and its database` |

Check a login **from another pod**, never from inside `postgres-0`: the image trusts the local
socket and `127.0.0.1` without a password, so a login from inside proves nothing.

Until the backups exist (Phase 6), **a lost server means lost data**. Retain protects against
`kubectl` mistakes (a deleted claim or namespace), not against losing the disk. Then: restore
the newest dump from S3.

k3s's own data (the cluster state) isn't backed up on purpose: everything in it is rebuilt
from git and these scripts. Only the database holds data that can't be rebuilt.

### 6a. Re-attach a kept disk (the claim `data-postgres-0` was deleted)

The disk (a PersistentVolume, PV) shows `Released`, and its folder is still on the server.
Kubernetes never reuses it by itself. **Postgres must be stopped first.** A claim that a
running pod uses can't be deleted (it stays `Terminating`), and a running StatefulSet could
make a new, **empty** disk for `postgres-0` before the old one is back. Never remove a
`kubernetes.io/pvc-protection` finalizer to force things.

1. Write down which disk it is: the PV name, and its folder (`.spec.hostPath.path` or
   `.spec.local.path` in `kubectl get pv <pv> -o yaml`).
2. `kubectl -n relay scale sts postgres --replicas=0`, and wait until `postgres-0` is gone.
3. If the claim still exists: `kubectl -n relay delete pvc data-postgres-0`, and wait until the PV
   shows `Released`.
4. Free the PV for exactly one new claim, by removing only its old binding:
   `kubectl patch pv <pv> --type json -p '[{"op":"remove","path":"/spec/claimRef"}]'`
5. Create `data-postgres-0` again: class `local-path-retain`, `ReadWriteOnce`, `10Gi`, **and
   `volumeName: <pv>`**, so it can only bind to that disk. Wait for `Bound`, and check that its
   `volumeName` is the PV from step 1.
6. `kubectl -n relay scale sts postgres --replicas=1`. The data is back.

### 6b. A Secret was lost, but the disk was kept

The volume still has the old password, so the API can't log in. `bootstrap-secrets.sh` makes a
**new** password, and a new Secret **never** changes the password stored in Postgres. So set the
stored one to the new value, without the value ever leaving the server:

1. `ssh relay 'bash -s' < infra/server/bootstrap-secrets.sh` creates the missing Secret.
2. `kubectl -n relay delete pod postgres-0`. The new pod reads the new values into its env.
3. Set the stored password from the pod's own env. psql's `\getenv` reads it, so it's never on a
   command line, in shell history or in Postgres's log:

   ```bash
   ssh relay 'kubectl --kubeconfig ~/.kube/config -n relay exec -i postgres-0 -- psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres' <<'SQL'
   \getenv pw RELAY_DB_PASSWORD
   SET log_min_error_statement = panic;
   ALTER ROLE relay PASSWORD :'pw';
   SQL
   ```

   For `postgres-auth`, use `\getenv pw POSTGRES_PASSWORD` and `ALTER ROLE postgres …`. Only admins
   can `exec`, and the local socket needs no password.
4. `kubectl -n relay rollout restart deployment/relay-api`, so the API reads the new `url`.
5. Check a login from another pod (section 6).

Tested on 31 Oct (locally, same image): the new password, containing `'`, `;`, `$` and `"`,
logs in, the old one is refused, and the password appears 0 times in Postgres's log.

### 6c. The very first start failed halfway

If `10-create-relay.sh` failed (Postgres's log shows an error instead of `created the login
relay and its database`), the database exists but has no `relay` login. On the next start the
image sees an existing database and **skips** the script. This can only happen on a brand-new,
empty volume, so start over (ask the other person first: this deletes the volume):
1. Scale Postgres to 0.
2. Delete the PVC and then its PV.
3. Delete the PV's folder on the server (`sudo rm -rf <path from the PV>`).
4. Fix the script, then repeat steps 3–4 of section 6.

## Reboots

`unattended-upgrades` installs security updates every day but never reboots by itself
(`Automatic-Reboot` stays off, so a demo is never interrupted). After a kernel update
(`/var/run/reboot-required` exists), reboot by hand at a quiet time, never in the week of the
defense.

- **Before:** check that the running version is the last deploy, so a reboot can't quietly
  bring back an old image: `curl -s https://api.myrelay.tech/version` must show the same
  commit as `git rev-parse origin/main`. This is valid because every merge to main is built and
  deployed (`pipeline.yml` has no path filter on `push`). If a path filter ever comes back,
  compare with the last *deployed* commit instead, or this check reports a failure after every
  docs-only merge.
- **After:** `/version` answers again with that same commit, and `kubectl -n relay get pods`
  shows `postgres-0` and the API pods ready. Postgres can come up after the API: the API
  waits for it (from step 2.6).
