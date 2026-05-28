#!/bin/bash
# Cloud-init bootstrap for a fresh Ubuntu 22.04 EC2 instance.
# Installs Docker + docker compose, clones the repo, and leaves the rest for
# the operator to do over SSH (creating .env + `docker compose up -d`).

set -euxo pipefail

# Don't run twice
if [ -f /var/lib/deployit-bootstrapped ]; then
  exit 0
fi

# --- Docker ---
apt-get update -y
apt-get install -y ca-certificates curl gnupg git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
usermod -aG docker ubuntu

# --- Swap (t2.micro only has 1GB RAM, swap helps Docker builds) ---
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

# --- Clone repo into /opt/deployit ---
cd /opt
if [ ! -d deployit ]; then
  # NOTE: replace with your repo URL (must be public, or use a deploy key).
  git clone https://github.com/prachii05/deployit.git
  chown -R ubuntu:ubuntu deployit
fi

touch /var/lib/deployit-bootstrapped

cat <<'MSG' > /etc/motd

  ____            _              ___ _
 |  _ \  ___ _ __| | ___  _   _ |_ _| |_
 | | | |/ _ \ '_ \ |/ _ \| | | | | || __|
 | |_| |  __/ |_) | | (_) | |_| | | || |_
 |____/ \___| .__/|_|\___/ \__, |___|\__|
            |_|            |___/

Welcome. Next steps:
  cd /opt/deployit
  cp .env.example .env && vi .env       (fill in secrets)
  docker compose -f docker-compose.prod.yml up -d --build

MSG
