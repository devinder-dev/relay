# Rebuilding the server

How to get from a fresh VPS back to a running cluster, in order. Every setting that lives on the
server is in this folder or in `k8s/`. Only the web panels (one.com, get.tech) and GitHub's
settings are outside git.

Copy a file to the server with `ssh relay 'cat > /tmp/<name>' < infra/server/<name>`, then
run the command shown on the server. Commands that ask questions (`adduser`, the first `sudo`)
run alone, never inside a pasted block.

## 1. Outside the server (web panels)

- **one.com:** a VPS with Ubuntu 26.04 (4 vCPU, 8 GB). Two-step login on the account. Network
  firewall: allow TCP 22, 80 and 443.
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

## 5. Data (Phase 6)

Restore the newest database dump from S3. Until then, a lost server means lost data.
