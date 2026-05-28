FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate \
    && apk add --no-cache git
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/db/package.json ./packages/db/
COPY apps/worker/package.json ./apps/worker/
RUN pnpm install --filter @deployit/worker... --frozen-lockfile=false
COPY packages/db ./packages/db
COPY apps/worker ./apps/worker
RUN pnpm --filter @deployit/worker run build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/db ./packages/db
COPY --from=build /repo/apps/worker/dist ./apps/worker/dist
COPY --from=build /repo/apps/worker/templates ./apps/worker/templates
COPY --from=build /repo/apps/worker/package.json ./apps/worker/
CMD ["node", "apps/worker/dist/index.js"]
