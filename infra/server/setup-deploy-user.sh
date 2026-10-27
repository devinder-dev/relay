#!/usr/bin/env bash
# One-time setup of the "deploy" user that GitHub Actions logs in as (step 1.6b).
# Safe to run again: each part checks what already exists.
#
# Run it on the VPS as root, with the public half of the deploy key:
#   sudo bash setup-deploy-user.sh "ssh-ed25519 AAAA... relay-github-deploy"
set -euo pipefail

PUBKEY="${1:?usage: setup-deploy-user.sh '<deploy public key>'}"
KUBECTL="kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml"   # the admin kubeconfig, root only
HOME_DIR=/home/deploy

# 1. The user: its own home folder, no password (so it can't log in with one), no sudo.
if ! id deploy >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash deploy
fi

# 2. The key, locked to one program. "restrict" also turns off terminals and forwarding,
#    and command= runs relay-deploy whatever the client asks for (installed in step 1.6c).
install -d -m 700 -o deploy -g deploy "$HOME_DIR/.ssh"
echo "restrict,command=\"/usr/local/bin/relay-deploy\" $PUBKEY" > "$HOME_DIR/.ssh/authorized_keys"
chown deploy:deploy "$HOME_DIR/.ssh/authorized_keys"
chmod 600 "$HOME_DIR/.ssh/authorized_keys"

# 3. A token for the "deployer" ServiceAccount (k8s/platform/deployer.yaml).
#    Kubernetes fills in the token by itself; deleting this Secret revokes it.
$KUBECTL apply -f - <<'YAML'
apiVersion: v1
kind: Secret
metadata:
  name: deployer-token
  namespace: relay
  annotations:
    kubernetes.io/service-account.name: deployer
type: kubernetes.io/service-account-token
YAML
TOKEN=""
for _ in $(seq 1 20); do
  TOKEN=$($KUBECTL -n relay get secret deployer-token -o jsonpath='{.data.token}' | base64 -d || true)
  [ -n "$TOKEN" ] && break
  sleep 1
done
[ -n "$TOKEN" ] || { echo "the deployer token never appeared" >&2; exit 1; }

# 4. The deploy script's kubeconfig: the "deployer" badge, nothing more.
CA=$($KUBECTL config view --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')
install -d -m 700 -o deploy -g deploy "$HOME_DIR/.kube"
cat > "$HOME_DIR/.kube/config" <<YAML
apiVersion: v1
kind: Config
clusters:
  - name: relay
    cluster:
      server: https://127.0.0.1:6443
      certificate-authority-data: $CA
users:
  - name: deployer
    user:
      token: $TOKEN
contexts:
  - name: deployer
    context: { cluster: relay, user: deployer, namespace: relay }
current-context: deployer
YAML
chown deploy:deploy "$HOME_DIR/.kube/config"
chmod 600 "$HOME_DIR/.kube/config"

# 5. A copy of our public repo. The deploy script reads the manifests from it at the exact commit.
if [ ! -d "$HOME_DIR/relay/.git" ]; then
  sudo -u deploy git clone --quiet https://github.com/devinder-dev/relay.git "$HOME_DIR/relay"
fi

echo "deploy user ready"
