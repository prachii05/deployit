import "dotenv/config";

export const env = {
  DATABASE_URL:
    process.env.DATABASE_URL ?? "postgres://deployit:deployit@localhost:5433/deployit",
  WORK_DIR: process.env.WORK_DIR ?? "/tmp/deployit-builds",
  // Shared docker network that Caddy + user containers join.
  NETWORK: process.env.DEPLOYIT_NETWORK ?? "deployit-net",
  // Domain suffix appended to project slugs. .localhost auto-resolves to
  // 127.0.0.1 in browsers without /etc/hosts edits.
  DOMAIN: process.env.DEPLOYIT_DOMAIN ?? "localhost",
  // Public port Caddy is published on. 80 is hogged by Rancher Desktop on
  // macOS, so we use 8080 locally. URLs become http://<slug>.localhost:8080.
  PUBLIC_PORT: Number(process.env.DEPLOYIT_PUBLIC_PORT ?? 18080),
};
