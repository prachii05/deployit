FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps || npm install --force
COPY . .
RUN npm run build --if-present
RUN npm install -g serve 2>/dev/null || true
ENV PORT=3000
EXPOSE 3000
# If a build/ or dist/ folder exists (CRA, Vite, etc.) serve it statically.
# Otherwise fall back to npm start (Express/API servers).
CMD ["sh", "-c", "if [ -d build ]; then serve -s build -l 3000; elif [ -d dist ]; then serve -s dist -l 3000; else npm start; fi"]
