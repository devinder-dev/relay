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

The backup CronJob and restore manifests are in `k8s/data/`; setup and recovery are below.
Retain protects against `kubectl` mistakes (a deleted claim or namespace), not a lost disk.
Off-server recovery depends on a successful S3 upload and a verified restore; use the recorded
key and VersionId, never simply the newest object.

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

### 6d. Backups

`k8s/data/backup-cronjob.yaml` runs at **03:00 Europe/Stockholm** every day. An admin applies
it after the bucket and Secret exist. It dumps one consistent snapshot as `relay`, checks the
archive format, then uploads to `myrelay-tech-db-backups` in `eu-north-1`. Normal writes can
continue; a schema migration may wait for the dump. The format check is not full integrity:
the restore drill below is the proof that the data can be used.

The key can only upload under `relay/`: it cannot read, list or delete. A stolen key can upload
junk (costing money) or overwrite an existing key. Versioning keeps the previous version for
about 30 days after an overwrite, so we must notice within that window and recover by VersionId.
Current dumps expire after about 30 days; noncurrent versions remain about 30 more days.

**The upload must stay `aws s3api put-object`, never `aws s3 cp`.** `s3 cp` switches to a
multipart upload above 8 MiB, and multipart needs rights this key deliberately lacks, so backups
would work while the database is small and fail with `AccessDenied` the first night a dump
passed 8 MiB. `put-object` sends the file in one request, up to 5 GB, whatever its size; past
5 GB, the key's rights have to be redesigned, not just the command. Today's dump is about 17 KB.
Large upload with the real key, 7 Nov 2026: one 10,485,760-byte file through the same pod spec
and Secret went up in a single `put-object` with its VersionId and SHA-256 logged; the test
object was then deleted, every version. A wrong database password, also tested that day, fails
the dump (`password authentication failed`) and the upload container never starts.

Dumps contain signing secrets, API-key hashes, payloads and receiver excerpts. The private bucket,
SSE-S3 encryption and HTTPS protect storage and transport, not a compromised server or admin.
Never paste dump contents or secret-bearing SQL output into shared logs or a PR.
**A `.dump` file is as sensitive as the database itself:** the signing-secret column is not
encrypted, because we protect the backups instead (`docs/CONTEXT.md`). Never park one in
Downloads, a shared folder or a chat; the drill streams it, and its fallback deletes the file
straight after.

From the repo root on the laptop, apply only the CronJob (not the drill Pod):

```bash
ssh relay 'kubectl --kubeconfig ~/.kube/config apply -f -' < k8s/data/backup-cronjob.yaml
```

On the server, choose a fresh number for `<n>`. Never start a manual Job near 03:00:
`Forbid` prevents overlapping scheduled Jobs, but does not cover manual Jobs.

```bash
kubectl -n relay create job --from=cronjob/relay-backup relay-backup-manual-<n>
kubectl -n relay get cronjob,jobs
kubectl -n relay logs job/relay-backup-manual-<n> -c upload
```

Expect `uploaded key=... version_and_sha256=...`: the last two fields are VersionId and SHA-256.
Keep that record for the restore (Loki keeps the line too). A missing success line is not a
successful backup. `kubectl get cronjob` only shows `LAST SCHEDULE` (when a run started); the
last success is `kubectl -n relay get cronjob relay-backup -o jsonpath='{.status.lastSuccessfulTime}'`.
Check that, and the Job's completion. A controller more than an hour late skips that night;
a Job has 900 seconds including retries, with at most two retries.

The recovery point is **nominally daily**: the real age is the time since the last successful
dump. A failed night makes it older. **Nothing alerts yet: someone checks by hand**, including
the Sunday 03:00 run. These manifests and instructions alone are not evidence of a live backup.

### 6e. The backup key

An admin runs this once on the laptop. Values travel through stdin, never command arguments,
shell history or a local file. Do not use `--debug`, `set -x`, or `-o yaml` on the Secret.
IAM is global; S3 commands below name `eu-north-1` explicitly.

```bash
(
  set -euo pipefail
  aws iam create-access-key --user-name relay-backup --output json --no-cli-pager |
    jq -er '.AccessKey |
      select((.AccessKeyId | length) > 0 and (.SecretAccessKey | length) > 0) |
      "AWS_ACCESS_KEY_ID=\(.AccessKeyId)\nAWS_SECRET_ACCESS_KEY=\(.SecretAccessKey)"' |
    ssh -T relay 'kubectl --kubeconfig "$HOME/.kube/config" -n relay create secret generic relay-backup-s3 --from-env-file=/dev/stdin'
)
```

If any part fails, a key may exist without a usable Secret. Run
`aws iam list-access-keys --user-name relay-backup`, identify the newly orphaned key (do not
delete the working one), then
`aws iam delete-access-key --user-name relay-backup --access-key-id <orphan-id>` and retry.
The secret half cannot be fetched again. On the server,
`kubectl -n relay describe secret relay-backup-s3` must list exactly `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY`; this checks the names, not the connection. A successful backup tests it.

To rotate: keep the old key working, create a second key, replace the Secret, run one manual
backup and verify its upload, then delete the old key. For replacement, use the same pipeline
above but replace its final SSH command with this one (the values still travel only over stdin):

```bash
ssh -T relay 'set -eu; kubectl --kubeconfig "$HOME/.kube/config" -n relay delete secret relay-backup-s3; kubectl --kubeconfig "$HOME/.kube/config" -n relay create secret generic relay-backup-s3 --from-env-file=/dev/stdin'
```

Rotate away from scheduled or running Jobs: existing pods keep the old environment. If Secret
creation fails after deletion, keep the old key, recover the orphan as above and recreate the
Secret before the next backup. Never delete the old key until the replacement's backup succeeds.

### 6f. Restore drill (timed)

This is a temporary copy of production data. Delete it as soon as the drill is done, including
when a check fails. As a safety net, the Pod stops itself after 2 hours
(`activeDeadlineSeconds`), so plan the drill to finish well inside that. Use admin AWS credentials on the laptop: the backup key cannot download.
Commands below run on the laptop unless marked otherwise.

1. Apply the Pod, wait for readiness, then create the role and empty database. Preparation is
   outside the timed restore. The Pod has no TCP listener and no Service.

   ```bash
   ssh relay 'kubectl --kubeconfig ~/.kube/config apply -f -' < k8s/data/restore-drill.yaml
   ssh relay 'kubectl --kubeconfig ~/.kube/config -n relay wait --for=condition=Ready pod/relay-restore-drill --timeout=120s'
   ssh -T relay 'kubectl --kubeconfig ~/.kube/config -n relay exec -i relay-restore-drill -- psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres' <<'SQL'
   CREATE ROLE relay LOGIN NOSUPERUSER;
   CREATE DATABASE relay OWNER relay;
   SQL
   ```

2. Read the chosen successful Job's upload log (section 6d), not simply the newest S3 object.
   Set `KEY` and `VER` below to its recorded key and VersionId. The checksum is also in that
   log. Restore that version **as `relay`**, never as the superuser.

   **Run it in bash, not zsh** (zsh is the macOS default: type `bash` first). zsh's `MULTIOS`
   option sends a redirected output to the pipe *as well*, so the CLI's JSON answer would be
   mixed into the dump and `pg_restore` would fail. Found and tested on 7 Nov: in zsh,
   `{ echo json; echo BODY >&3; } 3>&1 1>&2 | cat` passes both lines into the pipe; bash only `BODY`.

   ```bash
   B=myrelay-tech-db-backups
   KEY='<recorded key>'
   VER='<recorded VersionId>'
   set -o pipefail
   time ( aws s3api get-object --region eu-north-1 --bucket "$B" --key "$KEY" --version-id "$VER" \
            --checksum-mode ENABLED /dev/fd/3 3>&1 1>&2 \
          | ssh -T relay 'kubectl --kubeconfig "$HOME/.kube/config" -n relay exec -i relay-restore-drill -- \
              pg_restore --no-owner --no-acl --exit-on-error -U relay -d relay' )
   ```

   File descriptor 3 sends the dump body into the pipe; the CLI's JSON answer goes to the
   terminal. `pipefail` makes a download failure fail the whole pipeline too. Record success
   only if the command exits zero. If streaming fails, delete and recreate the drill Pod
   before retrying: a partial restore is not an empty database. Fallback: download to a
   `mktemp` file on the laptop (mode 600), restore from it, then delete it immediately;
   include download and restore in the timing.

3. Check **as `relay`**. On the server, run the following for `relay-restore-drill`, then again
   with `postgres-0` for comparison. Only counts and ids are printed, never secrets. Table ids
   below come from the current migrations; choose one known production delivery id and replace
   the placeholder before running. Schema migration versions and table names must match.
   Counts may differ because production has grown since the snapshot; investigate missing
   relationships or an expected delivery absent from the snapshot.

   ```bash
   kubectl -n relay exec -i relay-restore-drill -- psql -X -v ON_ERROR_STOP=1 -U relay -d relay <<'SQL'
   SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;
   SELECT version FROM schema_migrations ORDER BY version;
   SELECT 'owners' AS table_name, count(*) FROM owners
   UNION ALL SELECT 'api_keys', count(*) FROM api_keys
   UNION ALL SELECT 'endpoints', count(*) FROM endpoints
   UNION ALL SELECT 'events', count(*) FROM events
   UNION ALL SELECT 'deliveries', count(*) FROM deliveries
   UNION ALL SELECT 'attempts', count(*) FROM attempts;
   SELECT d.id, e.id AS event_id, ep.id AS endpoint_id
   FROM deliveries d JOIN events e ON e.id = d.event_id
   JOIN endpoints ep ON ep.id = d.endpoint_id LIMIT 5;
   SELECT id FROM deliveries WHERE id = '<known delivery UUID>';
   SQL
   ```

4. On the server, delete the copy and check that it is gone:

   ```bash
   kubectl -n relay delete pod relay-restore-drill
   kubectl -n relay get pod relay-restore-drill
   ```

   Expect `NotFound`. Measured time covers download plus restore only, not rebuilding a lost
   server, k3s, Secrets or DNS.

Measured, 7 Nov 2026: the 14:46 UTC dump (`relay-backup-manual-1`, 17,851 bytes) restored as
`relay` in **1.46 s**, download plus restore, `pg_restore` exit 0. The SHA-256 S3 returned matched
the Job's log line. Every check matched production exactly: the same 7 tables, migration
`20261031140445`, the same row counts in all six tables, the joins, 58 constraints, 16 indexes
and the same delivery ids. The time grows with the database; today's is tiny.

### 6g. Restore into production (not rehearsed)

**Ask the other person first.** This deletes production's database. These steps are written,
not rehearsed; stop on any failure, leaving traffic stopped until the checks pass.

1. Freeze merges and wait for any active deploy to finish, so no deploy scales the app back up.
   Record the chosen backup's key and VersionId from a successful Job log.
2. On the server, suspend scheduled backups and wait for any already running backup Job to
   finish (suspending does not stop existing Jobs):

   ```bash
   kubectl -n relay patch cronjob relay-backup -p '{"spec":{"suspend":true}}'
   kubectl -n relay get jobs
   ```

3. Scale API and worker to zero and wait until their pods are gone. Both currently use fixed
   replicas. If autoscaling is added later, review this stop procedure before using it.

   ```bash
   kubectl -n relay scale deployment/relay-api deployment/relay-worker --replicas=0
   kubectl -n relay get pods
   ```

4. In `postgres-0`, recreate an **empty** database owned by `relay`. The role already exists;
   its password is not part of the dump. A lost server needs sections 1–6 first to rebuild
   Postgres and its Secrets.

   ```bash
   kubectl -n relay exec -i postgres-0 -- psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
   DROP DATABASE relay;
   CREATE DATABASE relay OWNER relay;
   SQL
   ```

5. From the laptop, **in bash** (see 6f), run 6f's streaming command with the chosen `KEY` and
   `VER`, changing only `relay-restore-drill` to `postgres-0`. Keep `set -o pipefail`, `--exit-on-error`,
   `--no-owner --no-acl` and `-U relay`. Never restore a dump as the superuser. If it fails,
   leave the app stopped and recreate the empty database before retrying.
6. Run 6f's checks as `relay` against `postgres-0`, comparing with the chosen backup's drill
   results and recorded migration versions. Do not resume traffic until the checks pass.
7. Scale back up, wait for both deployments, unsuspend backups, then lift the
   merge freeze:

   ```bash
   kubectl -n relay scale deployment/relay-api deployment/relay-worker --replicas=2
   kubectl -n relay rollout status deployment/relay-api
   kubectl -n relay rollout status deployment/relay-worker
   kubectl -n relay patch cronjob relay-backup -p '{"spec":{"suspend":false}}'
   ```

   A recent missed schedule may run when unsuspended; don't start a manual backup alongside it.
   After a lost-server recovery, rotate the backup key using 6e.

Pending deliveries in the snapshot may be sent again even if they were delivered afterwards.
That is **at-least-once delivery**: receivers must drop duplicates by `webhook-id`.

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
