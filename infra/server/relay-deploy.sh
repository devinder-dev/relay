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

REPO=/home/deploy/relay                       # our repo, cloned by setup-deploy-user.sh
export KUBECONFIG=/home/deploy/.kube/config   # the "deployer" badge

fail() { echo "relay-deploy: $*" >&2; exit 1; }

# 0. One deploy at a time: a second deploy waits here for up to 5 minutes.
#    The lock is released by itself when the script ends, even if it crashes.
exec 9>/home/deploy/.relay-deploy.lock
flock --wait 300 9 || fail "another deploy is still running"

SHA="${SSH_ORIGINAL_COMMAND:-}"

# 1. Gate 1: the input must be a full commit SHA, exactly 40 characters of 0-9 and a-f.
#    It runs first, because $SHA is used in git and sed below.
if ! [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  fail "invalid commit SHA: $SHA"
fi

# 2. Gate 2: the commit must be on main, which means it was merged through a reviewed PR.
git -C "$REPO" fetch --quiet origin main
if ! git -C "$REPO" merge-base --is-ancestor "$SHA" "origin/main"; then
  fail "commit $SHA is not part of origin/main's history"
fi

# 3. Move our copy of the repo to exactly that commit, so the manifests match the image.
#    --force: this copy is only for deploys, so any stray local change is thrown away.
git -C "$REPO" checkout --quiet --force --detach "$SHA"
[ -d "$REPO/k8s/app" ] || fail "no k8s/app folder at commit $SHA"

# 4. Apply every manifest in k8s/app, with the placeholder __GIT_SHA__ replaced by the commit.
#    The "---" line between files keeps them separate YAML documents.
echo "deploying $SHA"
for file in "$REPO"/k8s/app/*.yaml; do
  printf '\n---\n'
  sed "s/__GIT_SHA__/$SHA/g" "$file"
done | kubectl apply -f -

# 5. Wait until the new pods are ready. If they never are, go back to the previous version.
if ! kubectl rollout status deployment/relay-api --timeout=180s; then
  kubectl rollout undo deployment/relay-api || echo "relay-deploy: nothing to roll back to"
  fail "rollout of $SHA failed"
fi
echo "deployed $SHA"
