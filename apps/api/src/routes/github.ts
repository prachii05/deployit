/**
 * Receives GitHub webhook events. Currently only handles `push` to the
 * default branch — triggers a fresh deployment of the matching project.
 *
 * Mounted with express.raw() so we can verify the HMAC-SHA256 signature
 * over the exact bytes GitHub sent.
 */

import { Router, raw } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { projects, deployments } from "@deployit/db";
import { db } from "../db.js";
import { env } from "../env.js";

export const github = Router();

github.post(
  "/webhook",
  raw({ type: "application/json" }),
  async (req, res) => {
    const event = req.header("X-GitHub-Event");
    const sigHeader = req.header("X-Hub-Signature-256");
    const body = req.body as Buffer;

    if (!sigHeader || !sigHeader.startsWith("sha256=")) {
      return res.status(401).json({ error: "missing signature" });
    }

    // Verify HMAC. Constant-time compare to prevent timing attacks.
    const expected =
      "sha256=" +
      createHmac("sha256", env.WEBHOOK_SECRET).update(body).digest("hex");
    const a = Buffer.from(sigHeader);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return res.status(401).json({ error: "bad signature" });
    }

    // Always 200 for ping (GitHub's hook test event)
    if (event === "ping") {
      return res.json({ ok: true, msg: "pong" });
    }

    if (event !== "push") {
      return res.json({ ok: true, msg: `ignoring ${event}` });
    }

    type PushPayload = {
      ref: string;
      repository: { full_name: string; default_branch: string };
      head_commit?: { id: string; message: string };
    };
    const payload = JSON.parse(body.toString("utf8")) as PushPayload;

    // Only deploy when the default branch is pushed.
    const expectedRef = `refs/heads/${payload.repository.default_branch}`;
    if (payload.ref !== expectedRef) {
      return res.json({ ok: true, msg: `ignoring non-default branch ${payload.ref}` });
    }

    // Find the project by repo full_name. There may be multiple users with
    // the same repo connected; trigger deploy for each.
    const matches = await db
      .select()
      .from(projects)
      .where(eq(projects.repoFullName, payload.repository.full_name));

    if (matches.length === 0) {
      return res.status(404).json({ error: "no project for this repo" });
    }

    const ids: number[] = [];
    for (const proj of matches) {
      const [d] = await db
        .insert(deployments)
        .values({
          projectId: proj.id,
          status: "queued",
          commitSha: payload.head_commit?.id ?? null,
          commitMessage: payload.head_commit?.message ?? null,
        })
        .returning({ id: deployments.id });
      await db.update(projects).set({ status: "deploying" }).where(eq(projects.id, proj.id));
      ids.push(d!.id);
    }
    res.status(202).json({ ok: true, deploymentIds: ids });
  }
);
