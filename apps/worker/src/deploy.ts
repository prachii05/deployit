import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import Docker from "dockerode";
import tar from "tar-fs";
import { eq } from "drizzle-orm";
import {
  projects,
  deployments,
  envVars as envVarsTable,
  type Deployment,
  type Project,
  type getDb,
} from "@deployit/db";
import { env } from "./env.js";
import { detectFramework } from "./detect.js";
import { writeDockerfile, exposedPortFor } from "./templates.js";
import { DeploymentLogger } from "./logger.js";
import { upsertRoute } from "./caddy.js";
import { decrypt } from "./crypto.js";

type Db = ReturnType<typeof getDb>;

let docker: Docker;
export function setDocker(d: Docker): void {
  docker = d;
}

export async function runDeployment(
  db: Db,
  deployment: Deployment,
  project: Project
): Promise<void> {
  const log = new DeploymentLogger(db, deployment.id);
  const workDir = path.join(env.WORK_DIR, `build-${deployment.id}`);
  const containerName = `deployit-${project.slug}`;
  const imageTag = `${project.slug}:${deployment.id}`;

  try {
    await db
      .update(deployments)
      .set({ status: "building" })
      .where(eq(deployments.id, deployment.id));

    fs.mkdirSync(workDir, { recursive: true });
    await log.info(`📦 cloning ${project.repoUrl}`);
    await clone(project.repoUrl, workDir, log);

    await log.info("🔍 detecting framework…");
    const fw = detectFramework(workDir);
    await log.info(`→ ${fw}`);
    if (fw === "unknown") {
      throw new Error(
        "could not detect framework. Add a package.json or index.html or Dockerfile."
      );
    }
    await db.update(projects).set({ framework: fw }).where(eq(projects.id, project.id));

    await log.info("📝 writing Dockerfile");
    writeDockerfile(workDir, fw);

    await log.info("🔨 building image…");
    await buildImage(workDir, imageTag, log);

    await log.info("🛑 stopping previous container (if any)");
    await stopAndRemove(containerName);

    await ensureNetwork(env.NETWORK);

    const containerPort = exposedPortFor(fw);

    // Pull user-configured env vars from DB and decrypt them.
    const userEnv = await loadEnvVars(db, project.id);
    if (Object.keys(userEnv).length > 0) {
      await log.info(`🔐 injecting ${Object.keys(userEnv).length} env var(s)`);
    }

    await log.info(`🚀 starting container on network ${env.NETWORK}`);
    await runContainer({
      imageTag,
      containerName,
      containerPort,
      network: env.NETWORK,
      envVars: userEnv,
    });

    const host = `${project.slug}.${env.DOMAIN}`;
    await log.info(`🌐 configuring caddy route ${host} → ${containerName}:${containerPort}`);
    await upsertRoute({
      slug: project.slug,
      host,
      upstream: `${containerName}:${containerPort}`,
    });

    const defaultPort = env.SCHEME === "https" ? 443 : 80;
    const url = env.PUBLIC_PORT === defaultPort
      ? `${env.SCHEME}://${host}`
      : `${env.SCHEME}://${host}:${env.PUBLIC_PORT}`;
    await log.info(`✅ live at ${url}`);

    const completedAt = new Date();
    await db
      .update(deployments)
      .set({
        status: "live",
        imageTag,
        containerName,
        url,
        completedAt,
      })
      .where(eq(deployments.id, deployment.id));

    await db
      .update(projects)
      .set({ status: "live", liveDeploymentId: deployment.id })
      .where(eq(projects.id, project.id));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await log.err(`❌ ${msg}`);
    await db
      .update(deployments)
      .set({ status: "failed", error: msg, completedAt: new Date() })
      .where(eq(deployments.id, deployment.id));
    await db
      .update(projects)
      .set({ status: "failed" })
      .where(eq(projects.id, project.id));
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function clone(repoUrl: string, dest: string, log: DeploymentLogger): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("git", ["clone", "--depth", "1", repoUrl, dest], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    p.stdout.on("data", (b) => log.info(b.toString().trimEnd()));
    p.stderr.on("data", (b) => log.info(b.toString().trimEnd()));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`git clone exited ${code}`))
    );
  });
}

async function buildImage(
  context: string,
  tag: string,
  log: DeploymentLogger
): Promise<void> {
  const tarStream = tar.pack(context);
  const stream = await docker.buildImage(tarStream as unknown as NodeJS.ReadableStream, {
    t: tag,
  });

  await new Promise<void>((resolve, reject) => {
    let buildError: string | null = null;
    docker.modem.followProgress(
      stream,
      (err, _res) => {
        if (err) return reject(err);
        if (buildError) return reject(new Error(`Docker build failed: ${buildError}`));
        resolve();
      },
      (event: { stream?: string; error?: string; errorDetail?: { message: string } }) => {
        if (event.error) {
          buildError = event.errorDetail?.message ?? event.error;
          void log.err(buildError);
        } else if (event.stream) {
          const line = event.stream.trimEnd();
          if (line) void log.info(line);
        }
      }
    );
  });
}

async function stopAndRemove(name: string): Promise<void> {
  try {
    const c = docker.getContainer(name);
    const info = await c.inspect();
    if (info.State.Running) await c.stop({ t: 3 });
    await c.remove({ force: true });
  } catch {
    /* not found, ok */
  }
}

async function runContainer(opts: {
  imageTag: string;
  containerName: string;
  containerPort: number;
  network: string;
  envVars: Record<string, string>;
}): Promise<void> {
  // Convert {KEY: "val"} → ["KEY=val", ...] for Docker's Env field.
  // PORT is always set last so user env vars cannot override it.
  const envArray = [
    ...Object.entries(opts.envVars).map(([k, v]) => `${k}=${v}`),
    `PORT=${opts.containerPort}`,
  ];

  const container = await docker.createContainer({
    name: opts.containerName,
    Image: opts.imageTag,
    Env: envArray,
    ExposedPorts: { [`${opts.containerPort}/tcp`]: {} },
    HostConfig: {
      Memory: 256 * 1024 * 1024,
      NanoCpus: 500_000_000, // 0.5 CPU
      NetworkMode: opts.network,
      RestartPolicy: { Name: "on-failure", MaximumRetryCount: 3 },
    },
  });
  await container.start();
}

async function ensureNetwork(name: string): Promise<void> {
  const networks = await docker.listNetworks({ filters: { name: [name] } });
  if (networks.find((n) => n.Name === name)) return;
  await docker.createNetwork({ Name: name, Driver: "bridge" });
}

/**
 * Fetch all env vars for this project from the DB, decrypt their values, and
 * return them as a plain object ready to pass to Docker. Skips any rows whose
 * ciphertext fails to decrypt (e.g. key rotation, corrupted row) — better to
 * launch the app with one missing var than to fail the whole deploy.
 */
async function loadEnvVars(db: Db, projectId: number): Promise<Record<string, string>> {
  const rows = await db
    .select()
    .from(envVarsTable)
    .where(eq(envVarsTable.projectId, projectId));
  const out: Record<string, string> = {};
  for (const row of rows) {
    try {
      out[row.key] = decrypt(row.valueEncrypted);
    } catch (e) {
      console.error(`failed to decrypt env var ${row.key} for project ${projectId}:`, e);
    }
  }
  return out;
}
