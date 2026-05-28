# Build context: repo root (so the build can see pnpm-workspace + packages/db)
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /repo

# --- install + build the full workspace, then "deploy" the api as a self-
#     contained directory with a flat node_modules and all workspace deps
#     resolved to real files (not symlinks).
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/db/package.json ./packages/db/
COPY apps/api/package.json ./apps/api/
RUN pnpm install --frozen-lockfile=false
COPY packages/db ./packages/db
COPY apps/api ./apps/api
RUN pnpm --filter @deployit/db run build \
 && pnpm --filter @deployit/api run build \
 && pnpm deploy --filter @deployit/api --prod /prod

FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /prod /app
EXPOSE 4000
CMD ["node", "dist/server.js"]
