# DeployIt — Build Plan

A self-hostable Vercel: push to GitHub → live URL in ~90 seconds. Free, forever.

## Locked scope

**MVP (weeks 1-6):** GitHub OAuth, repo picker, framework auto-detect, Docker build/run, Caddy wildcard SSL, live build logs via WebSocket, GitHub webhooks → auto-deploy, dashboard.

**Standout features (weeks 7-9):** AI error explainer (Claude), one-click rollback, encrypted env vars, auto-sleep idle apps, optional built-in Postgres.

**Out of scope (v1):** monorepos with split FE/BE, GPUs, custom domains, teams/orgs, Windows containers, production-scale ops.

## Architecture (one box)

```
GitHub ── OAuth + webhooks ──┐
                             ▼
                  ┌──────────────────────┐
Cloudflare DNS ──►│  EC2 t2.micro        │
*.deployit.app    │  ┌────────────────┐  │
                  │  │ Caddy (80/443) │  │── wildcard SSL via LE DNS-01
                  │  └───┬──────────┬─┘  │
                  │      │          │    │
                  │      ▼          ▼    │
                  │   control     user-  │
                  │   plane       app-N  │ (128MB/0.25cpu each)
                  │   (Node)             │
                  │      │               │
                  │      ▼               │
                  │   worker ── docker.sock ─► host Docker daemon
                  │      │               │
                  │      ▼               │
                  │   Postgres (control) │
                  └──────────────────────┘
                            │
                            ▼
                      Claude API (AI explain)
```

## Tech stack

| Layer | Tech |
|---|---|
| Frontend | React 18 + TS + Vite + Tailwind |
| API (control plane) | Node 20 + Express + TS |
| Worker | Node + TS + `dockerode` |
| DB | Postgres 16 + Drizzle |
| Proxy | Caddy v2 (admin API for dynamic routes) |
| Auth | GitHub OAuth |
| AI | Claude API (BYO key) |
| Cloud | AWS EC2 t2.micro + EBS + EIP (free 12mo) |
| DNS/SSL | Cloudflare + Let's Encrypt |
| IaC | Terraform |

## Repo layout

```
deployit/
├── apps/
│   ├── web/         React dashboard
│   ├── api/         Control plane (Express + WS)
│   └── worker/      Build/run worker
├── packages/
│   └── db/          Shared Drizzle schema
├── infra/
│   ├── terraform/   EC2 + EBS + EIP + SG
│   └── caddy/       Caddyfile
├── docker-compose.yml       local dev
└── docker-compose.prod.yml  EC2
```

## 10-week schedule

| Week | Goal | Demo |
|---|---|---|
| 1 | Repo + GitHub OAuth login | Login on localhost ✅ |
| 2 | Dashboard + list user repos | Browse repos in UI |
| 3 | Manual Docker deploy of static page | nginx container serves page |
| 4 | Worker: clone → detect → build → run | Click Deploy → container running |
| 5 | Caddy + WS logs + multi-framework | Live logs, get URL |
| 6 | Terraform → AWS | Live at deployit.app |
| 7 | GitHub webhooks | `git push` redeploys |
| 8 | AI explainer + rollback | Fail → explain → rollback |
| 9 | Env vars + auto-sleep + Postgres | Full feature set |
| 10 | Polish, README, launch | r/selfhosted post |

## Week 1 status

- [x] Monorepo (pnpm workspaces)
- [x] DB schema (Drizzle)
- [x] API skeleton with `/auth/github` + `/auth/github/callback`
- [x] Web skeleton with login button
- [x] docker-compose for local Postgres
- [ ] Real GitHub OAuth app credentials (you supply via `.env`)
- [ ] `pnpm dev` end-to-end test

## Secrets & .env (you provide)

```
# apps/api/.env
DATABASE_URL=postgres://deployit:deployit@localhost:5432/deployit
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_OAUTH_CALLBACK=http://localhost:4000/auth/github/callback
SESSION_SECRET=<random 32 bytes>
ENCRYPTION_KEY=<random 32 bytes, hex>
WEB_ORIGIN=http://localhost:5173
ANTHROPIC_API_KEY=...      # week 8
```

Register GitHub OAuth app at https://github.com/settings/developers — callback `http://localhost:4000/auth/github/callback`.

## Day 1 — what to do after this scaffold

1. `pnpm install`
2. `docker compose up -d` (starts Postgres)
3. Copy `apps/api/.env.example` → `apps/api/.env`, fill GitHub OAuth creds
4. `pnpm --filter @deployit/db migrate`
5. `pnpm dev` (runs api + web concurrently)
6. Visit http://localhost:5173, click **Sign in with GitHub** → end up logged in
