#!/usr/bin/env bash
# PrometheusRule wraps ordinary Prometheus groups in Kubernetes metadata; promtool accepts only
# the inner groups. Extract that wrapper into a temporary file, then run the committed rule tests.
set -euo pipefail

PROMTOOL_BIN="${PROMTOOL:-promtool}"
command -v "$PROMTOOL_BIN" >/dev/null || {
  echo "promtool is required (set PROMTOOL=/path/to/promtool)" >&2
  exit 127
}

TASK_DIR=$(mktemp -d)
trap 'rm -rf "$TASK_DIR"' EXIT
sed -n '/^  groups:/,$p' k8s/monitoring/relay-alert-rules.yaml | sed 's/^  //' > "$TASK_DIR/rules.yaml"
sed "s|../relay-alert-rules.yaml|$TASK_DIR/rules.yaml|" \
  k8s/monitoring/tests/relay-alert-rules.test.yaml > "$TASK_DIR/tests.yaml"
"$PROMTOOL_BIN" test rules "$TASK_DIR/tests.yaml"
