#!/usr/bin/env bash
# A throwaway Postgres for the tests, the same on the laptop and in CI (step 2.6b).
# The same image as production (its digest is read from k8s/data/postgres.yaml) and the same
# first-start script, so the tests log in as "relay", never as the superuser.
#
#   up    start it on 127.0.0.1:55432, wait until it answers, then run the migrations
#   test  run every test (unit + integration) against it; extra arguments go to bun test
#   down  remove it: only the container this script made, which carries our label
#
# Nothing is kept: "down" also removes its storage, so the next "up" starts empty.
set -euo pipefail

NAME=relay-test-pg
PORT=55432
LABEL_KEY=relay.test-db
# Throwaway values for a container that listens on 127.0.0.1 only. Not secrets.
PASSWORD="test" # quoted: unquoted, shellcheck reads it as the `test` command
export DATABASE_URL="postgres://relay:$PASSWORD@127.0.0.1:$PORT/relay?sslmode=disable"

API_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$API_DIR/.." && pwd)"
INITDB_DIR="$REPO_DIR/k8s/data/initdb"

fail() { echo "❌ test-db: $*" >&2; exit 1; }

# Step 1: helpers that look, never change anything.
exists() { docker container inspect "$NAME" >/dev/null 2>&1; }
ours() { [ "$(docker container inspect -f "{{index .Config.Labels \"$LABEL_KEY\"}}" "$NAME" 2>/dev/null)" = "1" ]; }
running() { [ "$(docker container inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = "true" ]; }
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; }

# The image production runs, pinned by digest. One source of truth: the StatefulSet.
prod_image() {
  local image
  image=$(sed -n 's/^ *image: *\(postgres:[^ ]*\).*/\1/p' "$REPO_DIR/k8s/data/postgres.yaml" | head -n 1)
  [[ "$image" =~ ^postgres:[0-9.]+@sha256:[0-9a-f]{64}$ ]] || fail "couldn't read a pinned postgres image from k8s/data/postgres.yaml"
  echo "$image"
}

remove_ours() {
  ours || fail "a container named $NAME exists but this script didn't make it, so it's left alone"
  docker container rm --force --volumes "$NAME" >/dev/null # --volumes: its storage too
}

up() {
  docker info >/dev/null 2>&1 || fail "Docker isn't running"

  # Step 2: reuse ours if it's running; never touch anything else.
  if exists; then
    if running && ours; then
      echo "test-db: $NAME is already running, reusing it"
    else
      echo "test-db: $NAME exists but isn't running, removing it first"
      remove_ours
    fi
  fi

  # Step 3: start it, with the first-start script mounted read-only.
  if ! exists; then
    port_busy && fail "port $PORT on 127.0.0.1 is already in use by something else"
    docker run --detach --name "$NAME" --label "$LABEL_KEY=1" \
      --publish "127.0.0.1:$PORT:5432" \
      --env POSTGRES_PASSWORD="$PASSWORD" --env RELAY_DB_PASSWORD="$PASSWORD" \
      --volume "$INITDB_DIR:/docker-entrypoint-initdb.d:ro" \
      "$(prod_image)" >/dev/null
    echo "test-db: started $NAME on 127.0.0.1:$PORT"
  fi

  # Step 4: wait for the real server. During the first start a temporary server listens on
  # the socket only, so asking over TCP (-h 127.0.0.1) only succeeds once that's finished.
  for _ in $(seq 1 60); do
    running || { docker logs --tail 30 "$NAME" >&2 || true; fail "$NAME stopped during its first start (log above)"; }
    docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U postgres && break
    sleep 1
  done
  docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U postgres || fail "$NAME didn't answer within 60 s"

  # Step 5: the migrations, logged in as relay, exactly as the migrate Job does it.
  (cd "$API_DIR" && bun run --bun db:migrate)
  echo "✅ test-db: ready. Run the tests with: bun run test:db"
}

down() {
  if exists; then
    remove_ours
    echo "✅ test-db: removed $NAME"
  else
    echo "test-db: nothing to remove"
  fi
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  test) shift; cd "$API_DIR" && exec bun test "$@" ;;
  *) echo "usage: test-db.sh up | test [bun test arguments] | down" >&2; exit 2 ;;
esac
