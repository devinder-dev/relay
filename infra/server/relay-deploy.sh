#!/usr/bin/env bash
# relay-deploy: the one program the deploy key may run (step 1.6c).
#
# GitHub Actions runs:   ssh deploy@<vps> <commit-sha>
# SSH ignores that command and starts this script instead (the forced command in
# /home/deploy/.ssh/authorized_keys). What the client asked for arrives in
# $SSH_ORIGINAL_COMMAND, so for us it is the commit to deploy. Treat it as untrusted.
#
# Installed by root as /usr/local/bin/relay-deploy, owned by root, so the deploy user
# can run it but not change it. Everything it prints shows up in the GitHub Actions log.
set -euo pipefail

REPO=/home/deploy/relay                        # our repo, cloned by setup-deploy-user.sh
LAST_GOOD_FILE=/home/deploy/.relay-last-good   # the last commit that deployed successfully
export KUBECONFIG=/home/deploy/.kube/config    # the "deployer" badge
# No kubectl call below says "-n relay": the namespace comes from this kubeconfig's context,
# which setup-deploy-user.sh sets to "relay". If that ever changes, these commands follow it.

fail() { echo "relay-deploy: $*" >&2; exit 1; }

SHA="${SSH_ORIGINAL_COMMAND:-}"

# 1. Gate 1: the input must be a full commit SHA, exactly 40 characters of 0-9 and a-f.
#    It runs first, because $SHA is used in git and sed below. It needs no lock.
if ! [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  fail "invalid commit SHA: $SHA"
fi

# 2. One deploy at a time: a second deploy waits here for up to 15 minutes. That's longer
#    than the worst case (deploy + rollback, 180 s per Deployment each). In CI this rarely
#    waits at all, because the pipeline already runs main's deploys one after the other;
#    it protects against an admin deploying by hand at the same moment.
#    The lock is released by itself when the script ends, even if it crashes.
exec 9>/home/deploy/.relay-deploy.lock
flock --wait 900 9 || fail "another deploy is still running after 15 minutes: nothing was changed, re-run this job"

# 3. Gate 2: the commit must be on main, which means it was merged through a reviewed PR.
git -C "$REPO" fetch --quiet origin main
if ! git -C "$REPO" merge-base --is-ancestor "$SHA" "origin/main"; then
  fail "commit $SHA is not part of origin/main's history"
fi

# When a rollout fails, show why in the CI log: the pods' states and Kubernetes' latest
# events (an image that can't be pulled, a failing probe, a crash). "|| true": printing
# them must never change the result.
show_state() {
  echo "--- pods"
  kubectl get pods -o wide || true
  echo "--- latest events"
  kubectl get events --sort-by=.lastTimestamp 2>&1 | tail -n 20 || true
}

# Deploys one commit: its manifests in k8s/app/ with its images, then waits until every
# Deployment it touched is ready. Returns 0 on success and 1 on any failure.
# Every step ends with "|| return 1": inside a function that is called from "if", set -e
# is switched off, so without it a failing command would be ignored.
deploy_commit() {
  local commit="$1" applied deployment

  # Move our copy of the repo to exactly that commit, so the manifests match the images.
  # --force: this copy is only for deploys, so any stray local change is thrown away.
  git -C "$REPO" checkout --quiet --force --detach "$commit" || return 1
  if [ ! -d "$REPO/k8s/app" ]; then
    echo "relay-deploy: no k8s/app folder at commit $commit" >&2
    return 1
  fi

  # Apply every manifest, with the placeholder __GIT_SHA__ replaced by the commit.
  # The "---" line between files keeps them separate YAML documents.
  # -o name prints what was applied, for example "deployment.apps/relay-api".
  echo "deploying $commit"
  applied=$(for file in "$REPO"/k8s/app/*.yaml; do
              printf '\n---\n'
              sed "s/__GIT_SHA__/$commit/g" "$file"
            done | kubectl apply -f - -o name) || return 1
  echo "$applied"

  # Wait until each Deployment it touched has its new pods ready (the API, the dashboard,
  # and later the worker), so one that never gets ready can't pass as a success.
  for deployment in $(echo "$applied" | grep '^deployment'); do
    if ! kubectl rollout status "$deployment" --timeout=180s; then
      show_state
      return 1
    fi
  done
  return 0 # says "success" on purpose, not by luck of what happens to run last
}

# 4. Deploy the commit. On success, remember it as the last good one.
if deploy_commit "$SHA"; then
  echo "$SHA" > "$LAST_GOOD_FILE"
  echo "deployed $SHA"
  exit 0
fi

# 5. The deploy failed: put the last good commit back, manifests and images.
if [ -f "$LAST_GOOD_FILE" ]; then
  last_good=$(cat "$LAST_GOOD_FILE")
  # The note's content goes into git and sed below, just like $SHA, so it gets gate 1's check.
  if ! [[ "$last_good" =~ ^[0-9a-f]{40}$ ]]; then
    fail "deploy of $SHA failed, and the last-good note is damaged ('$last_good'): a human is needed"
  fi
  echo "rolling back to last good commit $last_good"
  deploy_commit "$last_good" || fail "rollback to $last_good failed"
  echo "rolled back to $last_good"
else
  echo "no last good commit to roll back to"
fi

# Safety net: whatever happens above, a failed deploy must never end with exit 0.
fail "deploy of $SHA failed"
