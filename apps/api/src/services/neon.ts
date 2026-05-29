/**
 * Neon Serverless Postgres provisioning.
 *
 * One shared Neon project (owned by the platform operator) — each "Add
 * Database" call creates an isolated role + database inside it. The user
 * never needs a Neon account; they just click a button.
 *
 * API reference: https://api-docs.neon.tech/reference/getting-started-with-neon-api
 */

const NEON_API = "https://console.neon.tech/api/v2";

type NeonRole = { name: string; password: string };
type NeonDatabase = { name: string; owner_name: string };
type NeonEndpoint = { host: string; type: string };
type NeonBranch = { id: string; name: string; primary: boolean };

function headers(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function neonFetch<T>(
  apiKey: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${NEON_API}${path}`, {
    ...init,
    headers: headers(apiKey),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Neon API ${path} → ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

async function getDefaultBranch(
  apiKey: string,
  projectId: string
): Promise<string> {
  const data = await neonFetch<{ branches: NeonBranch[] }>(
    apiKey,
    `/projects/${projectId}/branches`
  );
  const primary = data.branches.find((b) => b.primary) ?? data.branches[0];
  if (!primary) throw new Error("Neon: no branches found in project");
  return primary.id;
}

async function getPrimaryEndpointHost(
  apiKey: string,
  projectId: string
): Promise<string> {
  const data = await neonFetch<{ endpoints: NeonEndpoint[] }>(
    apiKey,
    `/projects/${projectId}/endpoints`
  );
  // Use the read-write endpoint; avoid read-only replicas.
  const ep =
    data.endpoints.find((e) => e.type === "read_write") ?? data.endpoints[0];
  if (!ep) throw new Error("Neon: no endpoints found in project");
  return ep.host;
}

/**
 * Create an isolated role + database for one DeployIt project.
 * Returns a ready-to-use `postgresql://` connection string.
 *
 * @param slug  Project slug — used as both the role and database name.
 *              Postgres identifiers are 63 chars max; slugs are always short.
 */
export async function provisionDatabase(opts: {
  apiKey: string;
  projectId: string;
  slug: string;
}): Promise<{ connectionString: string; roleName: string; dbName: string }> {
  const { apiKey, projectId, slug } = opts;

  const branchId = await getDefaultBranch(apiKey, projectId);
  const host = await getPrimaryEndpointHost(apiKey, projectId);

  // Neon role names are Postgres identifiers — replace hyphens with underscores.
  const roleName = slug.replace(/-/g, "_");
  const dbName = roleName;

  // Create the role. If it already exists Neon returns 409 — treat as ok.
  let password: string;
  try {
    const roleRes = await neonFetch<{ role: NeonRole }>(
      apiKey,
      `/projects/${projectId}/branches/${branchId}/roles`,
      {
        method: "POST",
        body: JSON.stringify({ role: { name: roleName } }),
      }
    );
    password = roleRes.role.password;
  } catch (e) {
    const msg = String(e);
    if (!msg.includes("409")) throw e;
    // Role exists — reset password to get a known value.
    const reset = await neonFetch<{ role: NeonRole }>(
      apiKey,
      `/projects/${projectId}/branches/${branchId}/roles/${roleName}/reset_password`,
      { method: "POST" }
    );
    password = reset.role.password;
  }

  // Create the database owned by the role we just made.
  try {
    await neonFetch<{ database: NeonDatabase }>(
      apiKey,
      `/projects/${projectId}/branches/${branchId}/databases`,
      {
        method: "POST",
        body: JSON.stringify({ database: { name: dbName, owner_name: roleName } }),
      }
    );
  } catch (e) {
    // 409 = database already exists — fine, continue.
    if (!String(e).includes("409")) throw e;
  }

  // Use the pooler host for serverless apps (better for many short-lived
  // connections). Neon pooler is the main host with "-pooler" inserted.
  const poolerHost = host.replace(/^(ep-[^.]+)/, "$1-pooler");
  const connectionString = `postgresql://${roleName}:${encodeURIComponent(password)}@${poolerHost}/${dbName}?sslmode=require`;

  return { connectionString, roleName, dbName };
}

/**
 * Drop the role + database when a project is deleted.
 * Best-effort: errors are logged but don't fail the delete.
 */
export async function deprovisionDatabase(opts: {
  apiKey: string;
  projectId: string;
  roleName: string;
}): Promise<void> {
  const { apiKey, projectId, roleName } = opts;
  const branchId = await getDefaultBranch(apiKey, projectId);

  // Delete database first (role can't be dropped while it owns a DB).
  await neonFetch(
    apiKey,
    `/projects/${projectId}/branches/${branchId}/databases/${roleName}`,
    { method: "DELETE" }
  ).catch((e) => console.error("neon: delete database failed:", e));

  await neonFetch(
    apiKey,
    `/projects/${projectId}/branches/${branchId}/roles/${roleName}`,
    { method: "DELETE" }
  ).catch((e) => console.error("neon: delete role failed:", e));
}
