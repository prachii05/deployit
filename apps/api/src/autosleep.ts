/**
 * Auto-sleep loop: stops containers that have seen no traffic for a while,
 * freeing RAM on small VMs. Wake-on-visit (see routes/waking.ts) brings them
 * back when someone hits the URL again.
 *
 * Activity detection is free and dependency-light: we read each running
 * container's cumulative network RX byte counter from Docker stats. If it
 * grew since the last check, the app served a request, so we bump
 * `lastActiveAt`. Once now − lastActiveAt exceeds the idle threshold, we
 * sleep the project.
 *
 * RX bytes survive nothing across restarts, so we treat the first observation
 * of a container as "active now" to give freshly-(re)started apps a full
 * grace window.
 */

import { eq } from "drizzle-orm";
import { projects } from "@deployit/db";
import { db } from "./db.js";
import { docker, sleepProject } from "./routes/projects.js";

const CHECK_INTERVAL_MS = 60_000; // re-evaluate every minute
const IDLE_MINUTES = Number(process.env.AUTOSLEEP_MINUTES ?? 30);

// slug → last observed cumulative RX bytes
const lastRx = new Map<string, number>();

async function containerRxBytes(slug: string): Promise<number | null> {
  try {
    const stats = (await docker
      .getContainer(`deployit-${slug}`)
      .stats({ stream: false })) as unknown as {
      networks?: Record<string, { rx_bytes: number }>;
    };
    if (!stats.networks) return 0;
    return Object.values(stats.networks).reduce((sum, n) => sum + (n.rx_bytes ?? 0), 0);
  } catch {
    // Container not running / not found.
    return null;
  }
}

async function tick(): Promise<void> {
  const live = (await db.select().from(projects)).filter((p) => p.status === "live");

  for (const p of live) {
    const rx = await containerRxBytes(p.slug);
    if (rx === null) continue; // container gone; leave status alone

    const prev = lastRx.get(p.slug);
    const sawTraffic = prev === undefined || rx > prev;
    lastRx.set(p.slug, rx);

    if (sawTraffic) {
      // First sighting or real traffic → mark active now.
      await db
        .update(projects)
        .set({ lastActiveAt: new Date() })
        .where(eq(projects.id, p.id));
      continue;
    }

    const idleMs = Date.now() - new Date(p.lastActiveAt).getTime();
    if (idleMs >= IDLE_MINUTES * 60_000) {
      console.log(`💤 auto-sleeping ${p.slug} (idle ${Math.round(idleMs / 60_000)}m)`);
      try {
        await sleepProject(p);
        lastRx.delete(p.slug);
      } catch (e) {
        console.error(`auto-sleep failed for ${p.slug}:`, e);
      }
    }
  }
}

export function startAutoSleep(): void {
  if (IDLE_MINUTES <= 0) {
    console.log("auto-sleep disabled (AUTOSLEEP_MINUTES <= 0)");
    return;
  }
  console.log(`✓ auto-sleep enabled: idle threshold ${IDLE_MINUTES}m`);
  setInterval(() => {
    tick().catch((e) => console.error("auto-sleep tick error:", e));
  }, CHECK_INTERVAL_MS);
}
