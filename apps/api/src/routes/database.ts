/**
 * One-click database provisioning (Neon Serverless Postgres).
 *
 *   POST   /api/projects/:id/database   →  provision + inject DATABASE_URL
 *   DELETE /api/projects/:id/database   →  deprovision
 *   GET    /api/projects/:id/database   →  status (exists or not)
 */

import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { projects, databases, envVars } from "@deployit/db";
import { db } from "../db.js";
import { env } from "../env.js";
import { encrypt } from "../crypto.js";
import { provisionDatabase, deprovisionDatabase } from "../services/neon.js";

export const databaseRouter = Router({ mergeParams: true });

databaseRouter.get("/", async (req, res) => {
  const projectId = Number((req.params as { projectId: string }).projectId);
  const proj = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, req.user!.id)))
    .limit(1);
  if (!proj[0]) return res.status(404).json({ error: "not found" });

  const existing = await db
    .select()
    .from(databases)
    .where(eq(databases.projectId, projectId))
    .limit(1);

  res.json({
    hasDatabase: !!existing[0],
    neonEnabled: !!(env.NEON_API_KEY && env.NEON_PROJECT_ID),
  });
});

databaseRouter.post("/", async (req, res) => {
  if (!env.NEON_API_KEY || !env.NEON_PROJECT_ID) {
    return res.status(501).json({ error: "Database provisioning is not configured" });
  }

  const projectId = Number((req.params as { projectId: string }).projectId);
  const proj = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, req.user!.id)))
    .limit(1);
  if (!proj[0]) return res.status(404).json({ error: "not found" });

  // One database per project.
  const existing = await db
    .select()
    .from(databases)
    .where(eq(databases.projectId, projectId))
    .limit(1);
  if (existing[0]) return res.status(409).json({ error: "Database already exists" });

  const { connectionString, roleName } = await provisionDatabase({
    apiKey: env.NEON_API_KEY,
    projectId: env.NEON_PROJECT_ID,
    slug: proj[0].slug,
  });

  // Persist the database record — roleName stored in containerName for cleanup.
  await db.insert(databases).values({
    projectId,
    containerName: roleName,
    connectionStringEncrypted: encrypt(connectionString),
  });

  // Auto-upsert DATABASE_URL env var so it's injected on next deploy.
  const existing_env = await db
    .select()
    .from(envVars)
    .where(and(eq(envVars.projectId, projectId), eq(envVars.key, "DATABASE_URL")))
    .limit(1);

  if (existing_env[0]) {
    await db
      .update(envVars)
      .set({ valueEncrypted: encrypt(connectionString) })
      .where(eq(envVars.id, existing_env[0].id));
  } else {
    await db.insert(envVars).values({
      projectId,
      key: "DATABASE_URL",
      valueEncrypted: encrypt(connectionString),
    });
  }

  res.json({ ok: true, message: "Database provisioned — redeploy to connect" });
});

databaseRouter.delete("/", async (req, res) => {
  if (!env.NEON_API_KEY || !env.NEON_PROJECT_ID) {
    return res.status(501).json({ error: "Database provisioning is not configured" });
  }

  const projectId = Number((req.params as { projectId: string }).projectId);
  const proj = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, req.user!.id)))
    .limit(1);
  if (!proj[0]) return res.status(404).json({ error: "not found" });

  const dbRecord = await db
    .select()
    .from(databases)
    .where(eq(databases.projectId, projectId))
    .limit(1);
  if (!dbRecord[0]) return res.status(404).json({ error: "no database found" });

  // Deprovision from Neon — best effort, don't fail if already gone.
  await deprovisionDatabase({
    apiKey: env.NEON_API_KEY,
    projectId: env.NEON_PROJECT_ID,
    roleName: dbRecord[0].containerName,
  });

  // Remove from our DB and remove the DATABASE_URL env var.
  await db.delete(databases).where(eq(databases.id, dbRecord[0].id));
  await db
    .delete(envVars)
    .where(and(eq(envVars.projectId, projectId), eq(envVars.key, "DATABASE_URL")));

  res.json({ ok: true });
});
