/**
 * Auto-sleep loop: stops containers idle past the configured threshold to
 * free RAM on small VMs. Wake-on-visit (routes/waking.ts) brings them back.
 *
 * Activity is detected at the proxy layer (see activity.ts), not by polling
 * Docker — so this loop only does cheap work: an in-memory lookup per live
 * project, then a stop for any that have gone quiet. It also flushes the
 * in-memory "last seen" time into the DB so the idle clock survives restarts.
 */

import { eq } from "drizzle-orm";
import { projects } from "@deployit/db";
import { db } from "./db.js";
import { sleepProject } from "./routes/projects.js";
import { getLastSeen } from "./activity.js";

const CHECK_INTERVAL_MS = 60_000;
const IDLE_MINUTES = Number(process.env.AUTOSLEEP_MINUTES ?? 30);

async function tick(): Promise<void> {
  const live = await db
    .select()
    .from(projects)
    .where(eq(projects.status, "live"));

  const now = Date.now();
  for (const p of live) {
    const seen = getLastSeen(p.slug);

    // Persist fresh in-memory activity so the idle clock survives restarts.
    if (seen && seen > new Date(p.lastActiveAt).getTime()) {
      await db
        .update(projects)
        .set({ lastActiveAt: new Date(seen) })
        .where(eq(projects.id, p.id));
    }

    const lastActive = Math.max(seen ?? 0, new Date(p.lastActiveAt).getTime());
    if (now - lastActive >= IDLE_MINUTES * 60_000) {
      console.log(
        `💤 auto-sleeping ${p.slug} (idle ${Math.round((now - lastActive) / 60_000)}m)`
      );
      try {
        await sleepProject(p);
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
