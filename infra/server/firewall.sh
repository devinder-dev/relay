#!/usr/bin/env bash
# The server's own firewall, ufw (step 0.7). one.com's network firewall sits in front of it
# and is set in their web panel: exactly IPv4 TCP 22, 80 and 443, no "All" rule, nothing for
# IPv6. Two layers, so one mistake exposes nothing.
#
# Limit: ufw can't filter ports that Kubernetes publishes itself (NodePorts such as Traefik's
# 30795/32338, and hostPorts). Kubernetes redirects that traffic before ufw's rules see it,
# so for those ports one.com's firewall is the only layer.
#
# Run on the VPS:  sudo bash firewall.sh
# Safe to run again: ufw skips rules it already has.
set -euo pipefail

ufw default deny incoming     # everything not listed below is dropped
ufw default allow outgoing

ufw allow 22/tcp              # SSH, keys only
ufw allow 80/tcp              # HTTP: Let's Encrypt's check; everything else redirects to HTTPS
ufw allow 443/tcp             # HTTPS

# k3s's own networks: pods (10.42) and Services (10.43) talk to each other through the host.
ufw allow from 10.42.0.0/16 to any
ufw allow from 10.43.0.0/16 to any

# Never opened: 5432 (Postgres) and 6443 (the Kubernetes API).
ufw --force enable
ufw status verbose
