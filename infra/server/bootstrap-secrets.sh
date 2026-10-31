#!/usr/bin/env bash
# bootstrap-secrets: creates the database passwords as Kubernetes Secrets, on the server (step 2.2).
#
# Run it from the laptop, as an admin:
#   ssh relay 'bash -s' < infra/server/bootstrap-secrets.sh
# "bash -s" reads the script from SSH, so it runs on the server with your admin kubeconfig and
# nothing is copied to the server's disk.
#
# It creates each Secret ONLY IF IT'S MISSING, and prints only "created <name>" or "kept <name>".
# The passwords are made here, on the server, and never printed, logged, written to a file or
# put on a command line (where "ps" would show them to every user on the server).
#
# Run it again any time: it never overwrites. That matters, because a Secret is only a copy of
# the password: Postgres stores its own copy on its volume when it first starts (step 2.3).
# A new Secret doesn't change that stored password; recovering from a lost Secret is in the runbook.
set -euo pipefail
umask 077   # anything bash writes for us (for example a large here-document) is readable only by us

# The namespace can be overridden to test the script in a throwaway namespace:
#   ssh relay 'NAMESPACE=secrets-test bash -s' < infra/server/bootstrap-secrets.sh
NAMESPACE="${NAMESPACE:-relay}"

fail() { echo "bootstrap-secrets: $*" >&2; exit 1; }

# kubectl with the admin kubeconfig, always in our namespace.
kube() { kubectl --kubeconfig "$HOME/.kube/config" -n "$NAMESPACE" "$@"; }

# A new random password: 32 random bytes from the kernel, as 64 characters of 0-9 and a-f.
# Hex, because base64's "/", "+" and "=" would break the postgres:// URL below.
# The check makes sure an openssl problem can never turn into an empty or odd password.
new_password() {
  local pw
  pw=$(openssl rand -hex 32) || fail "openssl couldn't make a password"
  [[ "$pw" =~ ^[0-9a-f]{64}$ ]] || fail "openssl gave an unexpected value"
  printf '%s' "$pw"
}

# ensure_secret <name>
# Creates the Secret <name> from the KEY=VALUE lines on stdin, but only if it doesn't exist yet.
# Prints "kept <name>" or "created <name>", never a value.
ensure_secret() {
  local name="$1" found
  # --ignore-not-found gives three clear answers: nothing printed = missing, a line = it exists,
  # a failed command = we couldn't check (no connection, no permission). Never treat "couldn't
  # check" as "missing": never write when we couldn't read.
  found=$(kube get secret "$name" --ignore-not-found) || fail "couldn't check for Secret $name"
  if [[ -n "$found" ]]; then
    echo "kept $name"
  else
    # The values come from stdin, never from the command line (where "ps" would show them).
    kube create secret generic "$name" --from-env-file=/dev/stdin >/dev/null || fail "couldn't create Secret $name"
    echo "created $name"
  fi
}


# Step 1: the superuser's password. Only admins use it, through "kubectl exec".
# Made first, then handed over: if openssl failed inside the here-document itself, bash would
# carry on with an empty password instead of stopping.
superuser_password=$(new_password)
ensure_secret postgres-auth <<EOF
password=$superuser_password
EOF
unset superuser_password

# Step 2: the app's own login "relay": its password (for Postgres's first-start script, step 2.3)
# and the full URL with that password in it (for the API and the migrate Job).
# sslmode=disable: no TLS inside the cluster, because this traffic never leaves the server.
app_password=$(new_password)
ensure_secret relay-db <<EOF
password=$app_password
url=postgres://relay:$app_password@postgres.$NAMESPACE.svc.cluster.local:5432/relay?sslmode=disable
EOF
unset app_password
