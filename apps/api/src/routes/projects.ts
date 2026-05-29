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
import { envVarsRouter } from "./env-vars.js";

export const projectsRouter = Router();

projectsRouter.use(requireAuth);

// Nested resource: /api/projects/:projectId/env-vars
projectsRouter.use("/:projectId/env-vars", envVarsRouter);

// Try common Docker socket locations so this works in Docker (prod) and on a
// dev laptop running Rancher/Docker Desktop.
export const docker = new Docker({ socketPath: detectDockerSocket() });

// Max simultaneously running ("live" or "deploying") projects per user.
// Sleeping projects don't count — they use 0 RAM.
const MAX_LIVE_PER_USER = 3;

async function countActiveProjects(userId: number): Promise<number> {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.userId, userId));
  return rows.filter((p) => p.status === "live" || p.status === "deploying").length;
}

/**
 * Default Docker container port. Static sites use nginx on :80; everything
 * else listens on :3000 (see apps/worker/src/templates.ts).
 */
function portFor(framework: string | null): number {
  return framework === "static" ? 80 : 3000;
}

function upstreamFor(slug: string, framework: string | null): string {
  return `deployit-${slug}:${portFor(framework)}`;
}

/**
 * Poll the just-started container until it accepts an HTTP connection, so we
 * only report "live" once the app is actually serving — not just when the
 * container kernel started. All services share deployit-net, so the API can
 * reach the app container by name. Resolves true on first response, false on
 * timeout (caller still proceeds — a slow app shouldn't block waking).
 */
async function waitForReady(
  slug: string,
  framework: string | null,
  timeoutMs = 15_000
): Promise<boolean> {
  const url = `http://deployit-${slug}:${portFor(framework)}/`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000);
      // Any HTTP response (even 404/500) means the app is listening.
      await fetch(url, { signal: ctrl.signal, redirect: "manual" });
      clearTimeout(t);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

const CADDY_ADMIN = process.env.CADDY_ADMIN_URL ?? "http://caddy:2019";

/**
 * Swap a project's Caddy route. When sleeping, traffic is sent to our own
 * API which serves the "waking up" page; when live, traffic goes back to
 * the container.
 */
async function setCaddyRoute(opts: {
  slug: string;
  host: string;
  target: "container" | "waking";
  framework: string | null;
}): Promise<void> {
  const route =
    opts.target === "container"
      ? {
          "@id": opts.slug,
          match: [{ host: [opts.host] }],
          handle: [
            {
              handler: "reverse_proxy",
              upstreams: [{ dial: upstreamFor(opts.slug, opts.framework) }],
            },
          ],
        }
      : {
          "@id": opts.slug,
          match: [{ host: [opts.host] }],
          handle: [
            {
              // Caddy's `subroute` lets us match by path inside a single
              // outer route. The wake endpoint passes through to the API
              // unchanged; everything else gets rewritten to the waking
              // page. Without this split, the JS on the waking page can't
              // hit POST /__wake/:slug because it would be rewritten too.
              handler: "subroute",
              routes: [
                {
                  match: [{ path: ["/__wake/*", "/__waking*"] }],
                  handle: [
                    {
                      handler: "reverse_proxy",
                      upstreams: [{ dial: "api:4000" }],
                    },
                  ],
                },
                {
                  handle: [
                    {
                      handler: "rewrite",
                      uri: `/__waking?slug=${opts.slug}`,
                    },
                    {
                      handler: "reverse_proxy",
                      upstreams: [{ dial: "api:4000" }],
                    },
                  ],
                },
              ],
            },
          ],
        };

  const existing = await fetch(`${CADDY_ADMIN}/id/${opts.slug}`);
  if (existing.ok) {
    await fetch(`${CADDY_ADMIN}/id/${opts.slug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(route),
    });
  }
}

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

  // Per-user concurrency limit: only count OTHER projects (so re-deploying
  // an already-live project doesn't fail).
  if (proj[0].status !== "live" && proj[0].status !== "deploying") {
    const active = await countActiveProjects(req.user!.id);
    if (active >= MAX_LIVE_PER_USER) {
      return res.status(429).json({
        error: `Limit reached: max ${MAX_LIVE_PER_USER} active apps per user. Sleep one first.`,
      });
    }
  }

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

/**
 * Stop the live container to free RAM. The image stays — waking it up is
 * just `docker start`, no rebuild needed.
 */
projectsRouter.post("/:id/sleep", async (req, res) => {
  const id = Number(req.params.id);
  const proj = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, req.user!.id)))
    .limit(1);
  if (!proj[0]) return res.status(404).json({ error: "not found" });

  await sleepProject(proj[0]);
  res.json({ ok: true, status: "sleeping" });
});

/**
 * Stop a project's container and point its Caddy route at the waking page.
 * Shared by the manual Sleep button and the auto-sleep loop.
 */
export async function sleepProject(
  p: { id: number; slug: string; framework: string | null }
): Promise<void> {
  const containerName = `deployit-${p.slug}`;
  try {
    await docker.getContainer(containerName).stop({ t: 5 });
  } catch (e) {
    const err = e as { statusCode?: number };
    // 304 = not running, 404 = doesn't exist; both are fine.
    if (err.statusCode !== 304 && err.statusCode !== 404) throw e;
  }

  // Swap Caddy route so visitors see our "waking up" page instead of a 502.
  await setCaddyRoute({
    slug: p.slug,
    host: `${p.slug}.${new URL(env.WEB_ORIGIN).hostname}`,
    target: "waking",
    framework: p.framework,
  }).catch((e) => console.error("caddy swap to waking failed:", e));

  await db.update(projects).set({ status: "sleeping" }).where(eq(projects.id, p.id));
}

/**
 * Start a sleeping container. Fast — usually 1-3 seconds. Falls back to a
 * fresh deploy if the container was removed.
 */
projectsRouter.post("/:id/wake", async (req, res) => {
  const id = Number(req.params.id);
  const proj = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, req.user!.id)))
    .limit(1);
  if (!proj[0]) return res.status(404).json({ error: "not found" });

  // Per-user limit applies on wake too — sleeping projects use 0 RAM but
  // waking one up costs the same as deploying.
  const active = await countActiveProjects(req.user!.id);
  if (active >= MAX_LIVE_PER_USER) {
    return res.status(429).json({
      error: `Limit reached: max ${MAX_LIVE_PER_USER} active apps per user. Sleep one first.`,
    });
  }

  const result = await wakeProject(proj[0]);
  if (!result.ok) return res.status(409).json(result);
  return res.json(result);
});

/**
 * Shared wake logic used by both the authenticated wake endpoint and the
 * public "first visit wakes the app" endpoint.
 */
async function wakeProject(
  p: { id: number; slug: string; framework: string | null }
): Promise<{ ok: true; status: string } | { ok: false; error: string; action: string }> {
  const containerName = `deployit-${p.slug}`;
  try {
    const c = docker.getContainer(containerName);
    await c.start();
  } catch (e) {
    const err = e as { statusCode?: number };
    if (err.statusCode !== 304) {
      // Container missing — caller should trigger a fresh deploy.
      return { ok: false, error: "container missing, redeploy required", action: "deploy" };
    }
    // 304 = already running, fine.
  }

  await setCaddyRoute({
    slug: p.slug,
    host: `${p.slug}.${new URL(env.WEB_ORIGIN).hostname}`,
    target: "container",
    framework: p.framework,
  }).catch((e) => console.error("caddy swap to container failed:", e));

  // Wait until the app actually answers before reporting live, so the
  // dashboard doesn't flip to "live" while the URL still 502s.
  await waitForReady(p.slug, p.framework);

  await db
    .update(projects)
    .set({ status: "live", lastActiveAt: new Date() })
    .where(eq(projects.id, p.id));
  return { ok: true, status: "live" };
}

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
