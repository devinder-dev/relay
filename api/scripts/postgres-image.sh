#!/usr/bin/env bash
# Prints the Postgres image production runs, pinned by digest, for example
#   postgres:18.6@sha256:979bccfde35445db618c65107d27d08c6c21339d8dc3ad4c830c6633947be0e4
# One source of truth: the StatefulSet in k8s/data/postgres.yaml. Everything that starts a test
# Postgres (CI's migration smoke test, test-db.sh) asks this script, so a version bump there
# moves every test along with it, and no test can quietly keep checking an old image.
set -euo pipefail

MANIFEST="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/k8s/data/postgres.yaml"

image=$(sed -n 's/^ *image: *\(postgres:[^ ]*\).*/\1/p' "$MANIFEST" | head -n 1)
if [[ ! "$image" =~ ^postgres:[0-9.]+@sha256:[0-9a-f]{64}$ ]]; then
  echo "❌ postgres-image: no digest-pinned postgres image in $MANIFEST" >&2
  exit 1
fi
echo "$image"
