/**
 * Talks to Caddy's admin API (running on localhost:2019) to dynamically
 * add/remove reverse-proxy routes per deployment.
 *
 * Each route is identified by an @id matching the project slug, so updates
 * and deletes are idempotent.
 */

const ADMIN_URL = process.env.CADDY_ADMIN_URL ?? "http://localhost:2019";

type CaddyRoute = {
  "@id": string;
  match: Array<{ host: string[] }>;
  handle: Array<{
    handler: "reverse_proxy";
    upstreams: Array<{ dial: string }>;
  }>;
};

async function ensureServer(): Promise<void> {
  // PUT an empty server `srv0` if it doesn't exist yet. Caddy returns 404 on
  // GET if missing; PUT is idempotent.
  const res = await fetch(`${ADMIN_URL}/config/apps/http/servers/srv0`);
  if (res.ok) return;
  const ok = await fetch(`${ADMIN_URL}/config/apps/http/servers/srv0`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      listen: [":80"],
      routes: [],
    }),
  });
  if (!ok.ok) {
    throw new Error(`caddy: failed to init server (${ok.status})`);
  }
}

export async function upsertRoute(opts: {
  slug: string;
  host: string;
  upstream: string;
}): Promise<void> {
  await ensureServer();

  const route: CaddyRoute = {
    "@id": opts.slug,
    match: [{ host: [opts.host] }],
    handle: [
      {
        handler: "reverse_proxy",
        upstreams: [{ dial: opts.upstream }],
      },
    ],
  };

  // Try to update an existing route by @id; if it doesn't exist, append.
  const existing = await fetch(`${ADMIN_URL}/id/${opts.slug}`);
  if (existing.ok) {
    const res = await fetch(`${ADMIN_URL}/id/${opts.slug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(route),
    });
    if (!res.ok) throw new Error(`caddy: PATCH route failed (${res.status})`);
    return;
  }

  const res = await fetch(
    `${ADMIN_URL}/config/apps/http/servers/srv0/routes`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(route),
    }
  );
  if (!res.ok) throw new Error(`caddy: POST route failed (${res.status})`);
}

export async function removeRoute(slug: string): Promise<void> {
  const res = await fetch(`${ADMIN_URL}/id/${slug}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new Error(`caddy: DELETE route failed (${res.status})`);
  }
}
