FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate \
    && apk add --no-cache git
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/db/package.json ./packages/db/
COPY apps/worker/package.json ./apps/worker/
RUN pnpm install --frozen-lockfile=false
COPY packages/db ./packages/db
COPY apps/worker ./apps/worker
RUN pnpm --filter @deployit/db run build \
 && pnpm --filter @deployit/worker run build \
 && pnpm deploy --filter @deployit/worker --prod --legacy /prod \
 && cp -r apps/worker/templates /prod/templates

FROM node:20-alpine AS runner
RUN apk add --no-cache git
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /prod /app
CMD ["node", "dist/index.js"]
