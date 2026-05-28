FROM node:20-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY apps/web/package.json ./apps/web/
RUN pnpm install --filter @deployit/web... --frozen-lockfile=false
COPY apps/web ./apps/web
RUN pnpm --filter @deployit/web run build

FROM nginx:1.27-alpine AS runner
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
# Serve any unknown route from index.html (SPA routing)
RUN printf 'server { listen 80; root /usr/share/nginx/html; index index.html; \
location / { try_files $uri /index.html; } }' > /etc/nginx/conf.d/default.conf
EXPOSE 80
