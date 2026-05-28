# Build context: repo root (so it can see pnpm-workspace + packages/db)
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/db/package.json ./packages/db/
COPY apps/api/package.json ./apps/api/
RUN pnpm install --filter @deployit/api... --frozen-lockfile=false
COPY packages/db ./packages/db
COPY apps/api ./apps/api
RUN pnpm --filter @deployit/api run build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/db ./packages/db
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/package.json ./apps/api/
EXPOSE 4000
CMD ["node", "apps/api/dist/server.js"]
