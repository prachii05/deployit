/**
 * Request-activity tracking at the reverse-proxy layer.
 *
 * This is how managed platforms (Fly.io, Cloud Run) decide when an app is
 * idle: the proxy that sees every request reports activity, rather than
 * polling the container. We do the same, for free:
 *
 *   1. Enable Caddy's structured (JSON) access log on its server.
 *   2. Stream Caddy's logs through the Docker API (the socket is already
 *      mounted read-only for runtime logs).
 *   3. Parse each "handled request" entry, map its Host to a project slug,
 *      and stamp an in-memory "last seen" index.
 *
 * The auto-sleep loop reads that index — an O(1) memory lookup per project,
 * no `docker stats`, no per-request DB writes. The DB column `last_active_at`
 * is just the durable fallback used after a restart.
 */

import { PassThrough } from "node:stream";
import { projects } from "@deployit/db";
import { db } from "./db.js";
import { docker } from "./routes/projects.js";
import { env } from "./env.js";

const CADDY_ADMIN = process.env.CADDY_ADMIN_URL ?? "http://caddy:2019";
const CADDY_CONTAINER = process.env.CADDY_CONTAINER ?? "deployit-caddy-1";
const APP_DOMAIN = new URL(env.WEB_ORIGIN).hostname; // e.g. 1-2-3-4.sslip.io

// slug → epoch ms of the last request seen for that app.
const lastSeen = new Map<string, number>();

export function markActive(slug: string): void {
  lastSeen.set(slug, Date.now());
}

export function getLastSeen(slug: string): number | undefined {
  return lastSeen.get(slug);
}

/**
 * "myapp-abc123.1-2-3-4.sslip.io" → "myapp-abc123".
 * Returns null for the apex dashboard host or anything that isn't a
 * single-level subdomain of our app domain.
 */
function slugFromHost(host: string): string | null {
  const h = host.split(":")[0] ?? host; // strip any :port
  const suffix = `.${APP_DOMAIN}`;
  if (!h.endsWith(suffix)) return null;
  const sub = h.slice(0, -suffix.length);
  if (!sub || sub.includes(".")) return null;
  return sub;
}

/**
 * Turn on JSON access logging for Caddy's server via the admin API. Caddy is
 * configured entirely through this API (routes are added dynamically), so we
 * keep logging config there too. Idempotent and best-effort.
 */
async function ensureAccessLogging(): Promise<void> {
  const res = await fetch(`${CADDY_ADMIN}/config/apps/http/servers/srv0`);
  if (!res.ok) throw new Error(`caddy: cannot read srv0 (${res.status})`);
  const srv = (await res.json()) as { logs?: unknown };
  if (srv.logs) return; // already enabled
  const post = await fetch(`${CADDY_ADMIN}/config/apps/http/servers/srv0/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!post.ok) throw new Error(`caddy: enabling access log failed (${post.status})`);
}

type AccessEntry = {
  msg?: string;
  request?: { host?: string };
};

function handleLine(line: string): void {
  if (!line || line[0] !== "{") return;
  let entry: AccessEntry;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  if (entry.msg !== "handled request" || !entry.request?.host) return;
  const slug = slugFromHost(entry.request.host);
  if (slug) markActive(slug);
}

async function streamCaddyLogs(): Promise<void> {
  const caddy = docker.getContainer(CADDY_CONTAINER);
  // Only new lines (since "now"), follow forever.
  const stream = (await caddy.logs({
    follow: true,
    stdout: true,
    stderr: true,
    since: Math.floor(Date.now() / 1000),
    tail: 0,
  })) as unknown as NodeJS.ReadableStream;

  // Docker multiplexes stdout/stderr; demux both into one line stream.
  const out = new PassThrough();
  docker.modem.demuxStream(stream, out, out);

  let buf = "";
  out.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      handleLine(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
    }
  });

  await new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", reject);
  });
}

/**
 * Seed the index so a stale DB timestamp can't insta-sleep an app that's
 * actually being used right after an API restart: treat every currently-live
 * app as active "now", giving it a fresh grace window.
 */
async function seedGraceWindow(): Promise<void> {
  const live = (await db.select().from(projects)).filter((p) => p.status === "live");
  for (const p of live) markActive(p.slug);
}

export async function startActivityTracker(): Promise<void> {
  try {
    await ensureAccessLogging();
    await seedGraceWindow();
    console.log("✓ activity tracker: streaming Caddy access logs");
  } catch (e) {
    console.error("activity tracker setup failed (auto-sleep falls back to DB):", e);
  }

  // Reconnect loop — Caddy restarts, log rotation, etc. shouldn't kill us.
  const loop = async () => {
    for (;;) {
      try {
        await streamCaddyLogs();
      } catch (e) {
        console.error("activity tracker stream error:", e);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  };
  void loop();
}
