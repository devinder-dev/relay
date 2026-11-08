# Metrics and logs (Phase 7)

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
no credential in this folder and nothing to redact. Read it on the server if needed.

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
- **Application metrics: none.** Relay exposes no `/metrics` endpoint and no ServiceMonitor
  targets our pods, so nothing is collected about events, deliveries or retries. That is the
  remaining gap in G6, and `docs/CONTEXT.md` records it.
- **No alerting.** Alertmanager is disabled.
- **No backup.** Loki's and Prometheus's volumes are not backed up. Losing the node loses the
  history.

## Why each setting is what it is

Every choice made at install time now carries its reasoning as a comment in the values file it
belongs to, rather than in this README or in a pull request that will be closed: retention periods
and the disabled exporters in `kube-prometheus-stack-values.yaml`, retention, caches and the lost-
volume consequence in `loki-values.yaml`, and the namespace scope and label cardinality in
`alloy-values.yaml`. Read those files to answer "why 7 days?" or "why only `relay`?".
