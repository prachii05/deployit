/**
 * Per-project environment variables.
 *
 * Security model:
 *   - Values are encrypted at rest (AES-256-GCM, see crypto.ts).
 *   - GET never returns the plaintext value — only a short preview so the
 *     UI can show "DATABASE_URL = postg…" without leaking the full secret.
 *   - Only the owner of the project can read/write its env vars.
 *   - Reserved keys (PORT, etc.) cannot be set by users — the worker owns those.
 */

import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { envVars, projects } from "@deployit/db";
import { db } from "../db.js";
import { requireAuth } from "../middleware/session.js";
import { encrypt, decrypt } from "../crypto.js";

export const envVarsRouter = Router({ mergeParams: true });
envVarsRouter.use(requireAuth);

const RESERVED_KEYS = new Set(["PORT", "HOSTNAME", "HOME", "PATH"]);
const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

const createSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(128)
    .regex(KEY_PATTERN, "key must be UPPER_SNAKE_CASE (e.g. DATABASE_URL)"),
  value: z.string().min(1).max(8 * 1024), // 8 KB max
});

// Show only first 4 + last 2 chars so users can tell which secret is which
// without exposing the full value.
function mask(value: string): string {
  if (value.length <= 6) return "•".repeat(value.length);
  return `${value.slice(0, 4)}${"•".repeat(8)}${value.slice(-2)}`;
}

async function ensureOwned(projectId: number, userId: number) {
  const p = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  return p[0] ?? null;
}

envVarsRouter.get("/", async (req, res) => {
  const projectId = Number((req.params as unknown as { projectId: string }).projectId);
  const proj = await ensureOwned(projectId, req.user!.id);
  if (!proj) return res.status(404).json({ error: "not found" });

  const rows = await db
    .select()
    .from(envVars)
    .where(eq(envVars.projectId, projectId));

  // Decrypt only to produce a preview — full plaintext is never sent.
  const items = rows.map((r) => {
    let preview = "";
    try {
      preview = mask(decrypt(r.valueEncrypted));
    } catch {
      preview = "(corrupt)";
    }
    return { id: r.id, key: r.key, preview, createdAt: r.createdAt };
  });

  res.json({ envVars: items });
});

envVarsRouter.post("/", async (req, res) => {
  const projectId = Number((req.params as unknown as { projectId: string }).projectId);
  const proj = await ensureOwned(projectId, req.user!.id);
  if (!proj) return res.status(404).json({ error: "not found" });

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "invalid body", issues: parsed.error.issues });
  }
  const { key, value } = parsed.data;
  if (RESERVED_KEYS.has(key)) {
    return res.status(400).json({ error: `${key} is reserved by the platform` });
  }

  // Upsert: if key already exists for this project, replace it.
  const existing = await db
    .select()
    .from(envVars)
    .where(and(eq(envVars.projectId, projectId), eq(envVars.key, key)))
    .limit(1);

  if (existing[0]) {
    await db
      .update(envVars)
      .set({ valueEncrypted: encrypt(value) })
      .where(eq(envVars.id, existing[0].id));
    return res.json({ id: existing[0].id, key, preview: mask(value), updated: true });
  }

  const [created] = await db
    .insert(envVars)
    .values({ projectId, key, valueEncrypted: encrypt(value) })
    .returning();
  res.status(201).json({
    id: created!.id,
    key: created!.key,
    preview: mask(value),
    createdAt: created!.createdAt,
  });
});

envVarsRouter.delete("/:envId", async (req, res) => {
  const projectId = Number((req.params as unknown as { projectId: string }).projectId);
  const envId = Number(req.params.envId);
  const proj = await ensureOwned(projectId, req.user!.id);
  if (!proj) return res.status(404).json({ error: "not found" });

  await db
    .delete(envVars)
    .where(and(eq(envVars.id, envId), eq(envVars.projectId, projectId)));
  res.json({ ok: true });
});
