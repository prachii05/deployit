FROM node:20-alpine
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/db ./packages/db
RUN pnpm install --filter @deployit/db... --frozen-lockfile=false
WORKDIR /repo/packages/db
CMD ["pnpm", "run", "migrate"]
