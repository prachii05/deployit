import fs from "node:fs";
import path from "node:path";
import Docker from "dockerode";
import { eq, sql } from "drizzle-orm";
import { getDb, deployments, projects } from "@deployit/db";
import { env } from "./env.js";
import { runDeployment, setDocker } from "./deploy.js";

// Auto-detect Docker socket location
const socketPaths = [
  process.env.DOCKER_SOCKET,
  process.env.DOCKER_HOST?.replace("unix://", ""),
  path.join(process.env.HOME ?? "/", ".rd", "docker.sock"),
  path.join(process.env.HOME ?? "/", ".docker", "run", "docker.sock"),
  "/var/run/docker.sock",
].filter(Boolean);

let dockerSocket: string | undefined;
for (const p of socketPaths) {
  if (p && fs.existsSync(p)) {
    dockerSocket = p;
    break;
  }
}

if (!dockerSocket) {
  console.error("❌ could not find Docker socket at:", socketPaths);
  process.exit(1);
}

const docker = new Docker({ socketPath: dockerSocket });
setDocker(docker);

const db = getDb(env.DATABASE_URL);

console.log("⚙️  deployit worker starting");
console.log(`   DB: ${env.DATABASE_URL.replace(/:[^:@]+@/, ":***@")}`);
console.log(`   Docker: ${dockerSocket}`);

let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
  console.log("\nshutting down…");
});
process.on("SIGTERM", () => {
  stopping = true;
});

async function tick(): Promise<void> {
  // Atomically claim the next queued deployment.
  const claimed = await db
    .update(deployments)
    .set({ status: "building" })
    .where(
      sql`id = (
        SELECT id FROM deployments
        WHERE status = 'queued'
        ORDER BY started_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )`
    )
    .returning();

  const next = claimed[0];
  if (!next) return;

  const proj = await db.select().from(projects).where(eq(projects.id, next.projectId)).limit(1);
  const project = proj[0];
  if (!project) {
    console.error(`deployment ${next.id} has no project, marking failed`);
    await db
      .update(deployments)
      .set({ status: "failed", error: "project not found", completedAt: new Date() })
      .where(eq(deployments.id, next.id));
    return;
  }
  await runDeployment(db, next, project);
}

while (!stopping) {
  try {
    await tick();
  } catch (e) {
    console.error("tick error:", e);
  }
  await new Promise((r) => setTimeout(r, 1500));
}

console.log("bye");
process.exit(0);
