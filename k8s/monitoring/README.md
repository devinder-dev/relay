# Metrics, logs and alerts (Phase 7)

Prometheus, Grafana, Loki and Alloy, in namespace `monitoring`. Installed with Helm on
3 November 2026 and **running in production since then** - but until this folder existed they
lived only on the server, which made them the one part of the system this repository could not
rebuild. The values here were read back from the live releases with `helm get values`, so they
are what is running rather than what we meant to run - each file was checked to parse identically
to its live release.

These are the **overrides** we supplied, not the charts' full computed values. That is deliberate:
pinned to the chart versions in the table below, these overrides reproduce the release exactly,
while a dump of every computed default would be thousands of lines and would go stale the moment
a chart changed its own defaults.

| Release | Chart | Version | What it does |
|---|---|---|---|
| `monitoring` | `kube-prometheus-stack` | 92.17.1 | Prometheus (metrics), Grafana (graphs and log search), kube-state-metrics, node-exporter |
| `loki` | `loki` | 20.2.2 | Stores logs |
| `alloy` | `alloy` | 1.15.0 | Reads pod logs from namespace `relay` and pushes them to Loki |

## Why by hand, and never by the pipeline

The same boundary as `k8s/platform/`:

- The pipeline's Kubernetes account (`deployer`) is confined to namespace `relay`, cannot touch
  Secrets, and cannot create CRDs or cluster-wide roles. This stack needs all of those.
- Port 6443 is closed to the internet, so Helm cannot reach the cluster from CI at all. The
  pipeline deploys by running `relay-deploy` over SSH, and there is no Helm in that path.
- Deliberate: anything that decides who may do what is applied by a person after review, so a
  merged pull request can never quietly widen its own permissions.

Being in git does not change how it is applied. It means the by-hand step is reproducible from
the repository instead of from somebody's shell history, which is what
[`../README.md`](../README.md) already requires: *"Everything applied by hand is committed in the
same PR."*

`grafana-loki-datasource.yaml` is the exception: it is a change rather than a record. It is a
plain ConfigMap applied with `kubectl`, not part of the Helm release, because Grafana's datasource
sidecar watches for a labelled ConfigMap and reloads on its own - so adding a datasource needs no
chart upgrade and cannot roll Prometheus or the operator. **Applied on 8 Nov 2026**; Grafana
answered the sidecar's reload with `200 OK {"message":"Datasources config reloaded"}`.

```sh
ssh relay 'kubectl --kubeconfig ~/.kube/config apply -f -' < k8s/monitoring/grafana-loki-datasource.yaml
```

## Relay application metrics and alert rules

The API exposes a Prometheus-format `/metrics` endpoint on port 9090 and the worker on port 9091.
Neither has an Ingress and both are reachable only through ClusterIP Services. The platform
NetworkPolicy permits those ports only from namespace `monitoring`; worker health remains on 9090
for kubelet probes. The metric labels are deliberately bounded:
HTTP method, route template and response status, plus a small delivery outcome set. They never
contain customer URLs, ids, API keys, request ids or payload values.

`relay-servicemonitors.yaml` creates exactly two 30-second scrape targets: the API and worker.
`relay-alert-rules.yaml` adds availability (including missing series and scrape targets), sustained
API 5xx/latency, database-query, worker-loop-error, node resource/restart and backup rules.
Prometheus evaluates them and Grafana displays their state. They do
**not** notify anyone yet: Alertmanager remains disabled until an approved notification receiver
and its Secret are supplied. This is safer than pretending an unowned email or webhook is an
incident channel.

[`alertmanager-config.example.yaml`](alertmanager-config.example.yaml) is a deliberately inert
template for a future approved webhook. It selects a URL from a Secret in `monitoring`, but no
Secret, destination, or Alertmanager enablement is included here. Evaluated alert rules therefore
remain distinct from delivered notifications.

`grafana-relay-dashboard.yaml` is a compact dashboard provisioned through Grafana's dashboard
sidecar. It uses the existing Prometheus datasource (`uid: prometheus`); Loki remains the place to
inspect individual delivery logs.

Apply the platform NetworkPolicy first, then deploy the application commit that exposes its metrics
ports, and finally apply the ServiceMonitors, rules, and dashboard as an administrator. The CI
deployer intentionally has no custom-resource permissions:

```sh
ssh relay 'kubectl --kubeconfig ~/.kube/config apply --dry-run=server -f -' < k8s/platform/metrics-ingress.yaml
ssh relay 'kubectl --kubeconfig ~/.kube/config apply -f -' < k8s/platform/metrics-ingress.yaml
# Deploy the application commit through the normal relay-deploy path here.
ssh relay 'kubectl --kubeconfig ~/.kube/config apply --dry-run=server -f -' < k8s/monitoring/relay-servicemonitors.yaml
ssh relay 'kubectl --kubeconfig ~/.kube/config apply --dry-run=server -f -' < k8s/monitoring/relay-alert-rules.yaml
ssh relay 'kubectl --kubeconfig ~/.kube/config apply -f -' < k8s/monitoring/relay-servicemonitors.yaml
ssh relay 'kubectl --kubeconfig ~/.kube/config apply -f -' < k8s/monitoring/relay-alert-rules.yaml
ssh relay 'kubectl --kubeconfig ~/.kube/config apply -f -' < k8s/monitoring/grafana-relay-dashboard.yaml
```

After the application commit is deployed, verify targets and rules rather than assuming the
selectors or chart defaults match:

```sh
kubectl -n relay get servicemonitor
kubectl -n monitoring get prometheusrule relay
kubectl -n monitoring port-forward svc/monitoring-kube-prometheus-prometheus 9090:9090
# In another terminal: curl -fsS http://127.0.0.1:9090/api/v1/targets | jq '.data.activeTargets[] | select(.labels.namespace == "relay") | {labels,health}'
```

Before review, validate alert transitions locally with Prometheus's own parser. `PrometheusRule`
has a Kubernetes wrapper, so use the repository helper rather than passing it directly to
`promtool`:

```sh
PROMTOOL=/path/to/promtool bash scripts/test-prometheus-rules.sh
```

Rollback is reversible and does not affect API traffic: first roll back the application commit
through the normal `relay-deploy` path while `metrics-ingress.yaml` still protects the old metrics
ports. Then an administrator deletes the dashboard ConfigMap, ServiceMonitors, PrometheusRule and
the now-unused worker metrics Service. Delete `metrics-ingress.yaml` last. The deployer deliberately
cannot delete that Service. Do not delete existing Helm releases, Prometheus PVC or Loki PVC as
part of an alert rollback.

```sh
# Roll back the application commit through relay-deploy first.
ssh relay 'kubectl --kubeconfig ~/.kube/config delete -f -' < k8s/monitoring/grafana-relay-dashboard.yaml
ssh relay 'kubectl --kubeconfig ~/.kube/config delete -f -' < k8s/monitoring/relay-servicemonitors.yaml
ssh relay 'kubectl --kubeconfig ~/.kube/config delete -f -' < k8s/monitoring/relay-alert-rules.yaml
# After the application rollback, only when the Service is no longer in its manifests:
ssh relay 'kubectl --kubeconfig ~/.kube/config -n relay delete service relay-worker-metrics'
# Keep metrics restricted until the old ports and Service have gone.
ssh relay 'kubectl --kubeconfig ~/.kube/config delete -f -' < k8s/platform/metrics-ingress.yaml
```

## Its own namespace, and what it costs the node

`monitoring`, not `relay`, because node-exporter needs host access (the node's filesystem and
network namespace) and `relay` enforces Pod Security `restricted`, which refuses exactly that. So
the stack could not run in `relay` even if we wanted it there.

The memory limits add up to **about 3 GiB** of the node's 8 GB, which is worth knowing before
giving anything else headroom:

| | Limit |
|---|---|
| Prometheus | 1536Mi |
| Loki | 768Mi |
| Grafana | 512Mi |
| Alloy | 256Mi |
| **Total** | **3072Mi, exactly 3 GiB** |

That is the figure behind the API autoscaler's ceiling of four pods: what limits it is the `100m`
CPU request and the node's 4 vCPU, not memory, because this stack has already taken its share.

## Installing or upgrading

The chart repositories are not configured on the server (`helm repo list` is empty), so add them
first. These are the charts' own documented repositories; they were not read back from the server.

```sh
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update
```

Then, on the server (`ssh relay`), with the values from this folder:

```sh
helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace --version 92.17.1 \
  -f kube-prometheus-stack-values.yaml

helm upgrade --install loki grafana/loki \
  --namespace monitoring --version 20.2.2 -f loki-values.yaml

helm upgrade --install alloy grafana/alloy \
  --namespace monitoring --version 1.15.0 -f alloy-values.yaml
```

Versions are pinned on purpose. `--version` left off would install whatever is newest that day,
which is how a rebuild stops matching what was tested.

## Reaching Grafana

There is no Ingress and no public address: the Service is ClusterIP, so Grafana is reachable only
from inside the cluster. From a laptop:

```sh
ssh -L 3000:localhost:3000 relay
# then, on the server:
kubectl -n monitoring port-forward svc/monitoring-grafana 3000:80
# then open http://localhost:3000
```

The admin password is **not** in these values. The chart generated it into a Secret, so there is
no credential in this folder and nothing to redact. Log in as `admin`, with the password read on
the server:

```sh
kubectl -n monitoring get secret monitoring-grafana -o jsonpath='{.data.admin-password}' | base64 -d; echo
```

Grafana copies that password into its own database only on its first start. A change made later
inside Grafana stays in that database, and the Secret goes stale: on 23 Nov neither the password
we had saved nor the Secret's worked (Grafana's log said `invalid password` for `admin`). This
sets Grafana back to the Secret's value, through stdin so the password is never a command
argument:

```sh
kubectl -n monitoring get secret monitoring-grafana -o jsonpath='{.data.admin-password}' | base64 -d \
  | kubectl -n monitoring exec -i deploy/monitoring-grafana -c grafana -- \
      grafana cli admin reset-admin-password --password-from-stdin
```

## What this does and does not give us

- **Logs: collected.** Alloy collects every pod in namespace `relay` and pushes to Loki. Checked
  by querying Loki's own HTTP API and finding live lines from both API pods and the worker's
  retry-to-dead cycle.
- **Searching them in Grafana: working, after a fix.** The chart provisions only Prometheus and
  Alertmanager as datasources, and no Loki one existed in git - so a rebuild from this folder would
  have produced a Grafana that could not search logs at all.
  [`grafana-loki-datasource.yaml`](grafana-loki-datasource.yaml) declares it, and was applied on
  8 Nov. On a rebuild, apply it after the Helm releases.
- **Infrastructure metrics: working.** Prometheus scrapes the nodes, the kubelet, CoreDNS, the
  API server and kube-state-metrics.
- **Application metrics: collected.** The API reports request count, latency and an independent
  30-second `SELECT 1` database check; workers report
  finalized delivery outcomes, attempt duration and loop errors. Two ServiceMonitors scrape only
  their internal API port 9090 and worker port 9091 endpoints.
- **Alert rules: evaluated, not delivered.** Prometheus evaluates the conservative rules in this
  folder and Grafana shows their state. Alertmanager is intentionally disabled until an owned
  notification receiver is configured.
- **No backup.** Loki's and Prometheus's volumes are not backed up. Losing the node loses the
  history.

## Why each setting is what it is

Every choice made at install time now carries its reasoning as a comment in the values file it
belongs to, rather than in this README or in a pull request that will be closed: retention periods
and the disabled exporters in `kube-prometheus-stack-values.yaml`, retention, caches and the lost-
volume consequence in `loki-values.yaml`, and the namespace scope and label cardinality in
`alloy-values.yaml`. Read those files to answer "why 7 days?" or "why only `relay`?".
