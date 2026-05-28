#!/bin/bash
# Cloud-init bootstrap for a fresh Ubuntu 22.04 EC2 instance.
# - Installs Docker, AWS CLI, git
# - Adds 2 GB swap (t2.micro has only 1 GB RAM)
# - Clones the deployit repo
# - Fetches all secrets from SSM Parameter Store
# - Boots the full DeployIt stack via docker compose

set -euxo pipefail
exec > >(tee /var/log/deployit-bootstrap.log) 2>&1

if [ -f /var/lib/deployit-bootstrapped ]; then
  echo "already bootstrapped"
  exit 0
fi

# --- system packages ---
apt-get update -y
apt-get install -y ca-certificates curl gnupg git jq unzip

# --- AWS CLI v2 ---
ARCH=$(uname -m)
if [ "$ARCH" = "aarch64" ]; then AWS_ARCH=aarch64; else AWS_ARCH=x86_64; fi
curl -sSL "https://awscli.amazonaws.com/awscli-exe-linux-${AWS_ARCH}.zip" -o /tmp/awscliv2.zip
cd /tmp && unzip -q awscliv2.zip && ./aws/install
rm -rf /tmp/awscliv2.zip /tmp/aws

# --- Docker ---
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

# --- swap (t2.micro has 1 GB RAM; Docker builds need more) ---
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

# --- detect region from instance metadata (IMDSv2) ---
TOKEN=$(curl -sSL -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
REGION=$(curl -sSL -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/placement/region)
export AWS_DEFAULT_REGION=$REGION

# --- clone repo ---
cd /opt
if [ ! -d deployit ]; then
  git clone https://github.com/prachii05/deployit.git
fi
cd /opt/deployit
chown -R ubuntu:ubuntu /opt/deployit

# --- fetch secrets from SSM and write .env ---
fetch_param() {
  local v
  v=$(aws ssm get-parameter --name "/deployit/$1" --with-decryption \
    --query Parameter.Value --output text 2>/dev/null || echo "")
  # Treat the sentinel from seed-ssm.sh as empty.
  if [ "$v" = "__empty__" ]; then v=""; fi
  echo "$v"
}

# Wait up to 5 minutes for an operator to populate SSM (in case Terraform
# created the EC2 before secrets were stored).
for i in $(seq 1 30); do
  DOMAIN=$(fetch_param DOMAIN)
  if [ -n "$DOMAIN" ]; then break; fi
  echo "waiting for SSM secrets… ($i/30)"
  sleep 10
done

if [ -z "$DOMAIN" ]; then
  echo "❌ DOMAIN not found in SSM after 5 min. Run scripts/seed-ssm.sh from your laptop."
  exit 1
fi

cat > /opt/deployit/.env <<ENV
DOMAIN=$(fetch_param DOMAIN)
ACME_EMAIL=$(fetch_param ACME_EMAIL)
CLOUDFLARE_API_TOKEN=$(fetch_param CLOUDFLARE_API_TOKEN)
POSTGRES_PASSWORD=$(fetch_param POSTGRES_PASSWORD)
GITHUB_CLIENT_ID=$(fetch_param GITHUB_CLIENT_ID)
GITHUB_CLIENT_SECRET=$(fetch_param GITHUB_CLIENT_SECRET)
SESSION_SECRET=$(fetch_param SESSION_SECRET)
ENCRYPTION_KEY=$(fetch_param ENCRYPTION_KEY)
ANTHROPIC_API_KEY=$(fetch_param ANTHROPIC_API_KEY)
ENV
chmod 600 /opt/deployit/.env
chown ubuntu:ubuntu /opt/deployit/.env

# --- boot the stack ---
cd /opt/deployit
docker compose -f docker-compose.prod.yml up -d --build

touch /var/lib/deployit-bootstrapped
echo "✅ DeployIt bootstrap complete"
