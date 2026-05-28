import { Router } from "express";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import Docker from "dockerode";
import { statSync } from "node:fs";
import { projects, deployments } from "@deployit/db";
import { db } from "../db.js";
import { requireAuth } from "../middleware/session.js";
import { makeProjectSlug } from "../slug.js";
import { teardownProject } from "../infra.js";
import { registerWebhook, unregisterWebhook } from "../services/github.js";
import { decrypt } from "../crypto.js";
import { env } from "../env.js";

export const projectsRouter = Router();

projectsRouter.use(requireAuth);

// Try common Docker socket locations so this works in Docker (prod) and on a
// dev laptop running Rancher/Docker Desktop.
const docker = new Docker({ socketPath: detectDockerSocket() });

function detectDockerSocket(): string {
  const candidates = [
    process.env.DOCKER_HOST?.replace(/^unix:\/\//, ""),
    "/var/run/docker.sock",
    `${process.env.HOME}/.rd/docker.sock`,
    `${process.env.HOME}/.docker/run/docker.sock`,
  ].filter(Boolean) as string[];
  for (const path of candidates) {
    try {
      if (statSync(path).isSocket()) return path;
    } catch {
      // not present
    }
  }
  return "/var/run/docker.sock"; // fallback; dockerode will error on use
}

projectsRouter.get("/", async (req, res) => {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.userId, req.user!.id))
    .orderBy(desc(projects.createdAt));

  // Enrich with latestDeploymentId so the UI can always link to the most
  // recent deployment's build logs (even after the panel was closed).
  const enriched = await Promise.all(
    rows.map(async (p) => {
      const latest = await db
        .select({ id: deployments.id })
        .from(deployments)
        .where(eq(deployments.projectId, p.id))
        .orderBy(desc(deployments.id))
        .limit(1);
      return { ...p, latestDeploymentId: latest[0]?.id ?? null };
    })
  );

  res.json({ projects: enriched });
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

  // Best-effort: register a GitHub webhook so push-to-deploy works.
  try {
    const accessToken = decrypt(req.user!.accessTokenEncrypted);
    const hookId = await registerWebhook({
      accessToken,
      repoFullName,
      publicBaseUrl: env.WEB_ORIGIN,
    });
    if (hookId) {
      await db
        .update(projects)
        .set({ githubWebhookId: hookId })
        .where(eq(projects.id, created!.id));
      created!.githubWebhookId = hookId;
    }
  } catch (e) {
    console.error("webhook registration failed (non-fatal):", e);
  }

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

/**
 * Returns the most recent N lines of runtime logs from the live container
 * for this project. Unlike build logs (which are stored in postgres), runtime
 * logs are read directly from Docker on each request.
 */
projectsRouter.get("/:id/runtime-logs", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
  const tail = Math.min(Number(req.query.tail ?? 200), 1000);

  const proj = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, req.user!.id)))
    .limit(1);
  if (!proj[0]) return res.status(404).json({ error: "not found" });

  const containerName = `deployit-${proj[0].slug}`;
  try {
    const container = docker.getContainer(containerName);
    const buf = (await container.logs({
      stdout: true,
      stderr: true,
      follow: false,
      tail,
      timestamps: true,
    })) as unknown as Buffer;
    res.json({ logs: parseDockerLogStream(buf), container: containerName });
  } catch (e) {
    const err = e as { statusCode?: number; message?: string };
    if (err.statusCode === 404) {
      return res.json({
        logs: [],
        container: containerName,
        message: "container not running",
      });
    }
    res.status(500).json({ error: err.message ?? String(e) });
  }
});

projectsRouter.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });

  // Look up the project before deleting so we can tear down infra + webhook.
  const found = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, req.user!.id)))
    .limit(1);
  if (!found[0]) return res.status(404).json({ error: "not found" });

  await teardownProject(found[0].slug);

  if (found[0].githubWebhookId) {
    try {
      const accessToken = decrypt(req.user!.accessTokenEncrypted);
      await unregisterWebhook({
        accessToken,
        repoFullName: found[0].repoFullName,
        hookId: found[0].githubWebhookId,
      });
    } catch (e) {
      console.error("webhook unregister failed (non-fatal):", e);
    }
  }

  await db
    .delete(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, req.user!.id)));

  res.json({ ok: true });
});

/**
 * Parse the multiplexed format Docker uses for non-TTY containers:
 *   [stream byte][3 zero bytes][4-byte size BE][payload...]
 * stream byte: 1 = stdout, 2 = stderr
 * For TTY containers the output is plain UTF-8; we fall back to that.
 */
type RuntimeLogLine = { stream: "stdout" | "stderr"; ts: string | null; line: string };

function parseDockerLogStream(buf: Buffer): RuntimeLogLine[] {
  const out: RuntimeLogLine[] = [];
  if (!buf || buf.length === 0) return out;

  const multiplexed =
    buf.length >= 8 &&
    (buf[0] === 1 || buf[0] === 2) &&
    buf[1] === 0 &&
    buf[2] === 0 &&
    buf[3] === 0;

  if (!multiplexed) {
    splitLines(buf.toString("utf8")).forEach((l) => out.push(toLine("stdout", l)));
    return out;
  }

  let offset = 0;
  while (offset + 8 <= buf.length) {
    const streamType = buf[offset];
    const size = buf.readUInt32BE(offset + 4);
    if (offset + 8 + size > buf.length) break;
    const payload = buf.subarray(offset + 8, offset + 8 + size).toString("utf8");
    const stream: "stdout" | "stderr" = streamType === 2 ? "stderr" : "stdout";
    splitLines(payload).forEach((l) => out.push(toLine(stream, l)));
    offset += 8 + size;
  }
  return out;
}

function splitLines(s: string): string[] {
  return s.split("\n").filter((l) => l.length > 0);
}

function toLine(stream: "stdout" | "stderr", raw: string): RuntimeLogLine {
  // Docker --timestamps prefixes each line with an RFC3339Nano timestamp + space.
  const m = raw.match(/^(\d{4}-\d{2}-\d{2}T\S+)\s(.*)$/);
  if (m) return { stream, ts: m[1]!, line: m[2]! };
  return { stream, ts: null, line: raw };
}
