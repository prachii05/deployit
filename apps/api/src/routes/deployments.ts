import { Router } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  deployments,
  deploymentLogs,
  projects,
} from "@deployit/db";
import { db } from "../db.js";
import { requireAuth } from "../middleware/session.js";

export const deploymentsRouter = Router();

deploymentsRouter.use(requireAuth);

// Helper: ensure deployment belongs to the user
async function loadOwnedDeployment(deploymentId: number, userId: number) {
  const rows = await db
    .select({ deployment: deployments, project: projects })
    .from(deployments)
    .innerJoin(projects, eq(projects.id, deployments.projectId))
    .where(and(eq(deployments.id, deploymentId), eq(projects.userId, userId)))
    .limit(1);
  return rows[0];
}

deploymentsRouter.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
  const row = await loadOwnedDeployment(id, req.user!.id);
  if (!row) return res.status(404).json({ error: "not found" });
  res.json({ deployment: row.deployment });
});

deploymentsRouter.get("/:id/logs", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
  const since = req.query.since ? Number(req.query.since) : 0;
  const owned = await loadOwnedDeployment(id, req.user!.id);
  if (!owned) return res.status(404).json({ error: "not found" });

  const logs = await db
    .select()
    .from(deploymentLogs)
    .where(
      Number.isFinite(since) && since > 0
        ? and(eq(deploymentLogs.deploymentId, id), /* id > since */ undefined)
        : eq(deploymentLogs.deploymentId, id)
    )
    .orderBy(asc(deploymentLogs.id));

  const tail = since ? logs.filter((l) => l.id > since) : logs;
  res.json({
    logs: tail.map((l) => ({ id: l.id, ts: l.ts, line: l.line, stream: l.stream })),
  });
});

deploymentsRouter.get("/", async (req, res) => {
  const projectId = Number(req.query.projectId);
  if (!Number.isFinite(projectId)) return res.status(400).json({ error: "projectId required" });
  // verify ownership
  const owned = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, req.user!.id)))
    .limit(1);
  if (!owned[0]) return res.status(404).json({ error: "project not found" });

  const rows = await db
    .select()
    .from(deployments)
    .where(eq(deployments.projectId, projectId))
    .orderBy(desc(deployments.startedAt))
    .limit(20);
  res.json({ deployments: rows });
});
