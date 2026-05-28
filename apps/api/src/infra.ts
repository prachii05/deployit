import fs from "node:fs";
import path from "node:path";
import Docker from "dockerode";

const socketPaths = [
  process.env.DOCKER_SOCKET,
  process.env.DOCKER_HOST?.replace("unix://", ""),
  path.join(process.env.HOME ?? "/", ".rd", "docker.sock"),
  path.join(process.env.HOME ?? "/", ".docker", "run", "docker.sock"),
  "/var/run/docker.sock",
].filter(Boolean) as string[];

let dockerSocket: string | undefined;
for (const p of socketPaths) {
  if (fs.existsSync(p)) {
    dockerSocket = p;
    break;
  }
}

export const docker: Docker | null = dockerSocket
  ? new Docker({ socketPath: dockerSocket })
  : null;

const CADDY_ADMIN = process.env.CADDY_ADMIN_URL ?? "http://localhost:2019";

/**
 * Tear down everything associated with a project: container + Caddy route.
 * Best-effort: errors are logged but never thrown, since this runs in the
 * delete handler and a partial failure shouldn't block deleting the DB row.
 */
export async function teardownProject(slug: string): Promise<void> {
  const containerName = `deployit-${slug}`;

  if (docker) {
    try {
      const c = docker.getContainer(containerName);
      const info = await c.inspect().catch(() => null);
      if (info) {
        if (info.State.Running) await c.stop({ t: 3 }).catch(() => {});
        await c.remove({ force: true }).catch(() => {});
      }
    } catch (e) {
      console.error(`teardown: docker cleanup for ${slug}:`, e);
    }
  }

  try {
    const res = await fetch(`${CADDY_ADMIN}/id/${slug}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      console.error(`teardown: caddy DELETE ${slug} returned ${res.status}`);
    }
  } catch (e) {
    console.error(`teardown: caddy delete for ${slug}:`, e);
  }
}
