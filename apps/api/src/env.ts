import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(4000),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  GITHUB_OAUTH_CALLBACK: z.string().url(),
  SESSION_SECRET: z.string().min(16),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "ENCRYPTION_KEY must be 64 hex chars (32 bytes)"),
  // Shared secret GitHub uses to sign webhook payloads (HMAC-SHA256).
  // Generated once per platform install.
  WEBHOOK_SECRET: z.string().min(16),
  ANTHROPIC_API_KEY: z.string().optional(),
  // Neon serverless Postgres — used by the "Add Database" one-click feature.
  // Optional: if absent the button is hidden in the UI.
  NEON_API_KEY: z.string().optional(),
  NEON_PROJECT_ID: z.string().optional(),
});

export const env = schema.parse(process.env);
