import { Router } from "express";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { projects, deployments } from "@deployit/db";
import { db } from "../db.js";
import { requireAuth } from "../middleware/session.js";
import { makeProjectSlug } from "../slug.js";
import { teardownProject } from "../infra.js";

export const projectsRouter = Router();

projectsRouter.use(requireAuth);

projectsRouter.get("/", async (req, res) => {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.userId, req.user!.id))
    .orderBy(desc(projects.createdAt));
  res.json({ projects: rows });
});

const createSchema = z.object({
  repoFullName: z.string().regex(/^[^/]+\/[^/]+$/, "expected owner/repo"),
  repoUrl: z.string().url(),
});

projectsRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid body", issues: parsed.error.issues });
  }
  const { repoFullName, repoUrl } = parsed.data;

  const existing = await db
    .select()
    .from(projects)
    .where(
      and(eq(projects.userId, req.user!.id), eq(projects.repoFullName, repoFullName))
    )
    .limit(1);
  if (existing[0]) {
    return res.status(409).json({ error: "project for this repo already exists", project: existing[0] });
  }

  const repoName = repoFullName.split("/")[1] ?? "app";
  const slug = makeProjectSlug(repoName);

  const [created] = await db
    .insert(projects)
    .values({
      userId: req.user!.id,
      repoFullName,
      repoUrl,
      slug,
      status: "idle",
    })
    .returning();

  res.status(201).json({ project: created });
});

projectsRouter.post("/:id/deploy", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });

  const proj = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, req.user!.id)))
    .limit(1);
  if (!proj[0]) return res.status(404).json({ error: "not found" });

  const [created] = await db
    .insert(deployments)
    .values({ projectId: id, status: "queued" })
    .returning();

  await db.update(projects).set({ status: "deploying" }).where(eq(projects.id, id));

  res.status(202).json({ deployment: created });
});

projectsRouter.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });

  // Look up the slug before deleting so we can tear down infra.
  const found = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, req.user!.id)))
    .limit(1);
  if (!found[0]) return res.status(404).json({ error: "not found" });

  await teardownProject(found[0].slug);

  await db
    .delete(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, req.user!.id)));

  res.json({ ok: true });
});
