#!/usr/bin/env bash
# The server's own firewall, ufw (step 0.7). one.com's network firewall sits in front of it
# and is set in their web panel (TCP 22, 80, 443): two layers, so one mistake exposes nothing.
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
