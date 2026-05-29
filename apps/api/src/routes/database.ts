/**
 * One-click database provisioning (Neon Serverless Postgres) + a built-in
 * SQL editor for querying the provisioned database.
 *
 *   POST   /api/projects/:id/database         →  provision + inject DATABASE_URL
 *   DELETE /api/projects/:id/database         →  deprovision
 *   GET    /api/projects/:id/database         →  status (exists or not)
 *   POST   /api/projects/:id/database/query   →  run SQL, return rows
 */

import { Router } from "express";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { projects, databases, envVars } from "@deployit/db";
import { db } from "../db.js";
import { env } from "../env.js";
import { encrypt, decrypt } from "../crypto.js";
import { provisionDatabase, deprovisionDatabase } from "../services/neon.js";

// Guard rails for the SQL editor.
const MAX_SQL_LENGTH = 50_000;
const MAX_ROWS = 1000;
const STATEMENT_TIMEOUT_MS = 10_000;

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

/**
 * Built-in SQL editor. Runs arbitrary SQL against the project's provisioned
 * database and returns the rows.
 *
 * Safety: the query runs as the project's own Neon role, which Postgres
 * confines to that project's database — a user cannot reach another user's
 * data even with hand-crafted SQL. We also bound resource use per request:
 *   - a fresh single connection that's always closed (no pooling/leaks)
 *   - a server-side statement_timeout so a slow/runaway query can't hang
 *   - a row cap so a huge table can't be dumped into the browser
 */
databaseRouter.post("/query", async (req, res) => {
  const projectId = Number((req.params as { projectId: string }).projectId);
  const proj = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, req.user!.id)))
    .limit(1);
  if (!proj[0]) return res.status(404).json({ error: "not found" });

  const sqlText = typeof req.body?.sql === "string" ? req.body.sql.trim() : "";
  if (!sqlText) return res.status(400).json({ error: "sql is required" });
  if (sqlText.length > MAX_SQL_LENGTH) {
    return res.status(400).json({ error: "query too long" });
  }

  const dbRecord = await db
    .select()
    .from(databases)
    .where(eq(databases.projectId, projectId))
    .limit(1);
  if (!dbRecord[0]) {
    return res.status(404).json({ error: "no database — add one first" });
  }

  const connString = decrypt(dbRecord[0].connectionStringEncrypted);
  const sql = postgres(connString, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 5,
    // Server-side cap so runaway queries (e.g. pg_sleep) can't hold the conn.
    connection: { statement_timeout: STATEMENT_TIMEOUT_MS },
    // We deliberately ignore NOTICE noise.
    onnotice: () => {},
  });

  const startedAt = Date.now();
  try {
    // `.unsafe` runs a raw SQL string. That's intentional here: it's the
    // user's OWN isolated database, so "injection" has no cross-tenant reach.
    const result = await sql.unsafe(sqlText);
    const rows = Array.from(result as unknown as Record<string, unknown>[]);
    const truncated = rows.length > MAX_ROWS;
    const limited = truncated ? rows.slice(0, MAX_ROWS) : rows;
    // Column order from the first row (or empty for non-SELECT statements).
    const columns = limited[0] ? Object.keys(limited[0]) : [];

    res.json({
      columns,
      rows: limited,
      rowCount: rows.length,
      truncated,
      durationMs: Date.now() - startedAt,
    });
  } catch (e) {
    // Surface the Postgres error message only — never the connection string.
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ error: sanitize(msg, connString) });
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
});

/** Defensive: strip the connection string from any error text. */
function sanitize(msg: string, secret: string): string {
  return msg.split(secret).join("[redacted]");
}
