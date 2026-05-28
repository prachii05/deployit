#!/usr/bin/env bash
# Stores all DeployIt secrets into AWS SSM Parameter Store as SecureStrings.
# Run this once from your laptop, then the EC2 bootstrap will fetch them.
#
# Usage:
#   AWS_PROFILE=deployit ./infra/scripts/seed-ssm.sh

set -euo pipefail

: "${AWS_PROFILE:?Set AWS_PROFILE=deployit before running}"
REGION="${AWS_REGION:-ap-south-1}"

echo "Storing DeployIt secrets in SSM (region: $REGION, profile: $AWS_PROFILE)"
echo

put() {
  local name="$1"
  local value="$2"
  if [ -z "$value" ]; then
    # SSM doesn't allow empty strings; use a sentinel that the bootstrap
    # script can detect and treat as "unset".
    value="__empty__"
  fi
  aws ssm put-parameter \
    --region "$REGION" \
    --name "/deployit/$name" \
    --value "$value" \
    --type SecureString \
    --overwrite \
    --output text > /dev/null
  echo "  ✓ /deployit/$name"
}

prompt_secret() {
  local label="$1"
  local var
  read -r -s -p "$label: " var
  echo
  echo "$var"
}

prompt_value() {
  local label="$1"
  local default="${2:-}"
  local var
  if [ -n "$default" ]; then
    read -r -p "$label [$default]: " var
    echo "${var:-$default}"
  else
    read -r -p "$label: " var
    echo "$var"
  fi
}

# --- DOMAIN ---
DOMAIN=$(prompt_value "DOMAIN (e.g. 13-205-58-120.sslip.io)")
put DOMAIN "$DOMAIN"

# --- ACME_EMAIL ---
ACME_EMAIL=$(prompt_value "ACME_EMAIL (for Let's Encrypt notifications)")
put ACME_EMAIL "$ACME_EMAIL"

# --- GitHub OAuth (production app — different from local) ---
echo
echo "Register a new OAuth app at https://github.com/settings/developers"
echo "  Homepage:  https://$DOMAIN"
echo "  Callback:  https://$DOMAIN/auth/github/callback"
echo
GITHUB_CLIENT_ID=$(prompt_value "GITHUB_CLIENT_ID")
put GITHUB_CLIENT_ID "$GITHUB_CLIENT_ID"
GITHUB_CLIENT_SECRET=$(prompt_secret "GITHUB_CLIENT_SECRET (hidden)")
put GITHUB_CLIENT_SECRET "$GITHUB_CLIENT_SECRET"

# --- random secrets (auto-generated) ---
echo
echo "Generating random secrets…"
POSTGRES_PASSWORD=$(openssl rand -hex 24)
put POSTGRES_PASSWORD "$POSTGRES_PASSWORD"
SESSION_SECRET=$(openssl rand -hex 32)
put SESSION_SECRET "$SESSION_SECRET"
ENCRYPTION_KEY=$(openssl rand -hex 32)
put ENCRYPTION_KEY "$ENCRYPTION_KEY"

# --- optional ---
echo
read -r -p "ANTHROPIC_API_KEY (optional, press Enter to skip): " ANTHROPIC_API_KEY
put ANTHROPIC_API_KEY "${ANTHROPIC_API_KEY:-}"

# --- CLOUDFLARE_API_TOKEN: only needed if you want wildcard SSL via Cloudflare DNS-01.
#     For sslip.io HTTP-01 challenge (default), leave empty.
put CLOUDFLARE_API_TOKEN ""

echo
echo "✅ All secrets stored in SSM under /deployit/*"
echo
echo "Next steps:"
echo "  1. cd infra/terraform && terraform apply   (recreates EC2 with IAM role)"
echo "  2. Wait ~5 min for bootstrap to complete"
echo "  3. Visit https://$DOMAIN"
