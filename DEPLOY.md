# Deploying DeployIt to AWS (free tier)

End result: `https://deployit.yourdomain.com` running on an EC2 t2.micro, $0/month for 12 months.

## Prerequisites — get these first

| Thing | Why | Cost |
|---|---|---|
| AWS account | Run the VM | Free 12 months |
| Domain name | Real URL + SSL | ~$10/yr (cheapest at Cloudflare Registrar) |
| Cloudflare account | DNS + wildcard SSL | Free |
| `terraform` CLI installed | `brew install terraform` | Free |
| `aws` CLI configured (`aws configure`) | Terraform auth | Free |

## Step 1 — Buy a domain & point it at Cloudflare

1. Buy `something.app` (or `.com`, `.dev`, whatever) — Cloudflare Registrar is cheapest, no markup
2. If bought elsewhere, set its nameservers to Cloudflare's (the registrar gives instructions)
3. Wait ~5 min for nameservers to propagate

## Step 2 — Create a Cloudflare API token for SSL

1. https://dash.cloudflare.com/profile/api-tokens → **Create Token**
2. Use template **Edit zone DNS**
3. Zone Resources: include → specific zone → your domain
4. Save the token — you'll paste it into `.env` later

## Step 3 — Provision the VM with Terraform

```bash
cd infra/terraform
cat > terraform.tfvars <<EOF
ssh_public_key = "$(cat ~/.ssh/id_ed25519.pub)"   # or id_rsa.pub
ssh_cidr_blocks = ["YOUR_HOME_IP/32"]              # lock SSH to your IP
aws_region = "us-east-1"
EOF

terraform init
terraform apply
```

Terraform prints `public_ip` — note it down.

## Step 4 — Cloudflare DNS

Add two A records in Cloudflare:

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `@` (apex) | `<public_ip>` | DNS only |
| A | `*` (wildcard) | `<public_ip>` | DNS only |

> **Proxy must be OFF** ("DNS only", grey cloud) — Caddy handles SSL itself.

## Step 5 — SSH in and configure

```bash
ssh ubuntu@<public_ip>           # may take 1-2 min after apply for cloud-init
cd /opt/deployit
git pull                          # in case repo was updated
cp .env.example .env
vi .env                           # fill in everything
```

For `SESSION_SECRET` / `ENCRYPTION_KEY` / `POSTGRES_PASSWORD`:
```
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 24
```

Register a GitHub OAuth app at https://github.com/settings/developers:
- Homepage: `https://your.domain`
- Callback: `https://your.domain/auth/github/callback`

Paste the client ID + secret into `.env`.

## Step 6 — Boot the stack

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

First build: ~5-10 min on a t2.micro. Watch logs:

```bash
docker compose -f docker-compose.prod.yml logs -f
```

Wait for:
- `migrate` exits 0
- `api` prints `listening on http://localhost:4000`
- `caddy` settles (it'll fetch certs on first request to the domain)

## Step 7 — Visit your site

```
https://your.domain
```

You should see the DeployIt landing page with **Sign in with GitHub**. Click it, authorize, and you're in.

## Maintenance

### Deploy a code update

On the VM:
```bash
cd /opt/deployit
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

### View deployments

```bash
docker compose -f docker-compose.prod.yml logs -f api worker
```

### Restart everything

```bash
docker compose -f docker-compose.prod.yml restart
```

### Tear it all down

```bash
cd infra/terraform
terraform destroy
```

## Cost watch

Set a free billing alert in AWS for $1:
- Billing → Budgets → Create budget → $1 monthly → email yourself

After month 13 the t2.micro becomes ~$8/mo. Either pay it or migrate to Oracle Cloud Always Free (always free, 24 GB RAM ARM box).

## Limitations on t2.micro

- 1 GB RAM, 1 vCPU shared — can comfortably host ~3 small user apps concurrently
- Auto-sleep (Week 9) will be essential to stretch this further
- Docker builds use a lot of RAM; the bootstrap script adds a 2 GB swapfile to compensate

## Wildcard SSL note

The current `Caddyfile.prod` uses HTTP-01 (issues a cert per subdomain on demand). For instant wildcard SSL you need a Caddy build that includes the Cloudflare DNS plugin:

```dockerfile
FROM caddy:2.8-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2.8-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
```

Drop that into `infra/caddy/Dockerfile` and swap `caddy:2.8-alpine` for `build: ./infra/caddy` in `docker-compose.prod.yml`. Then add `tls { dns cloudflare {env.CLOUDFLARE_API_TOKEN} }` to the wildcard block in `Caddyfile.prod`. Skipped here to keep the v1 setup simple.
