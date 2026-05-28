/**
 * Public (unauthenticated) endpoints used when a sleeping app is visited.
 *
 *   GET  /__waking?slug=...   →  HTML page that polls + auto-wakes the app
 *   POST /__wake/:slug        →  starts the container + re-routes Caddy
 *
 * Anyone with the project's subdomain URL can already see/visit the app, so
 * the public wake endpoint doesn't expose anything new. We just don't want
 * to require sign-in from random visitors to wake somebody else's deployed
 * portfolio.
 */

import { Router } from "express";
import { eq } from "drizzle-orm";
import Docker from "dockerode";
import { statSync } from "node:fs";
import { projects, type Project } from "@deployit/db";
import { db } from "../db.js";
import { env } from "../env.js";

export const wakingRouter = Router();

const docker = new Docker({ socketPath: detectDockerSocket() });
function detectDockerSocket(): string {
  const candidates = [
    process.env.DOCKER_HOST?.replace(/^unix:\/\//, ""),
    "/var/run/docker.sock",
    `${process.env.HOME}/.rd/docker.sock`,
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    try {
      if (statSync(p).isSocket()) return p;
    } catch {
      // try next
    }
  }
  return "/var/run/docker.sock";
}

wakingRouter.get("/__waking", (req, res) => {
  const slug = String(req.query.slug ?? "");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(html(slug));
});

wakingRouter.post("/__wake/:slug", async (req, res) => {
  const slug = req.params.slug;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: "bad slug" });
  }

  const [proj] = await db
    .select()
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1);
  if (!proj) return res.status(404).json({ error: "not found" });
  if (proj.status === "live") return res.json({ ok: true, status: "live" });

  const containerName = `deployit-${slug}`;
  try {
    await docker.getContainer(containerName).start();
  } catch (e) {
    const err = e as { statusCode?: number };
    if (err.statusCode !== 304) {
      return res.status(409).json({ error: "container missing, redeploy required" });
    }
  }

  // Swap Caddy route back to the live container.
  const host = `${slug}.${new URL(env.WEB_ORIGIN).hostname}`;
  await swapToContainer(slug, host, proj.framework).catch((e) =>
    console.error("caddy swap failed:", e)
  );

  await db.update(projects).set({ status: "live" }).where(eq(projects.id, proj.id));
  res.json({ ok: true, status: "live" });
});

async function swapToContainer(
  slug: string,
  host: string,
  framework: Project["framework"]
): Promise<void> {
  const port = framework === "static" ? 80 : 3000;
  const adminUrl = process.env.CADDY_ADMIN_URL ?? "http://caddy:2019";
  const route = {
    "@id": slug,
    match: [{ host: [host] }],
    handle: [
      {
        handler: "reverse_proxy",
        upstreams: [{ dial: `deployit-${slug}:${port}` }],
      },
    ],
  };
  await fetch(`${adminUrl}/id/${slug}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(route),
  });
}

function html(slug: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Waking up…</title>
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0; height: 100%;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0a0a0b; color: #e5e7eb;
      display: flex; align-items: center; justify-content: center;
    }
    .card {
      text-align: center; padding: 2.5rem; max-width: 24rem;
    }
    .spinner {
      width: 2.5rem; height: 2.5rem; margin: 0 auto 1.25rem;
      border: 3px solid #27272a; border-top-color: #60a5fa;
      border-radius: 50%; animation: spin 0.9s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    h1 { font-size: 1.125rem; font-weight: 600; margin: 0 0 0.5rem; }
    p { color: #9ca3af; font-size: 0.875rem; margin: 0; line-height: 1.5; }
    .err { color: #fca5a5; font-size: 0.8rem; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h1>Waking up the app…</h1>
    <p>This app was sleeping to save resources.<br>It'll be ready in a few seconds.</p>
    <div class="err" id="err"></div>
  </div>
  <script>
    (async () => {
      const slug = ${JSON.stringify(slug)};
      const errEl = document.getElementById("err");
      try {
        const r = await fetch("/__wake/" + encodeURIComponent(slug), { method: "POST" });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          errEl.textContent = j.error || ("wake failed: " + r.status);
          return;
        }
        // Give the container a few seconds to start listening, then reload.
        let tries = 0;
        const interval = setInterval(async () => {
          tries++;
          try {
            const probe = await fetch("/", { cache: "no-store", redirect: "manual" });
            // Anything other than our own waking page means it's up.
            if (probe.ok || probe.type === "opaqueredirect" || probe.status >= 300) {
              clearInterval(interval);
              location.reload();
            }
          } catch {}
          if (tries > 30) {
            clearInterval(interval);
            errEl.textContent = "Took too long to wake. Try refreshing.";
          }
        }, 1000);
      } catch (e) {
        errEl.textContent = String(e);
      }
    })();
  </script>
</body>
</html>`;
}
