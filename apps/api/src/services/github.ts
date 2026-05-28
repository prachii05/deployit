/**
 * Thin GitHub API client used to register/unregister repo webhooks.
 * Uses the user's stored access_token (decrypted by caller).
 */

import { env } from "../env.js";

const GH = "https://api.github.com";

type Hook = { id: number; config: { url: string } };

export async function registerWebhook(opts: {
  accessToken: string;
  repoFullName: string;
  publicBaseUrl: string;
}): Promise<number | null> {
  // Skip if the host is local — GitHub can't reach localhost.
  if (
    opts.publicBaseUrl.includes("localhost") ||
    opts.publicBaseUrl.includes("127.0.0.1")
  ) {
    return null;
  }

  const url = `${opts.publicBaseUrl}/api/github/webhook`;

  // Check if a hook for this URL already exists (idempotent).
  const list = await fetch(`${GH}/repos/${opts.repoFullName}/hooks`, {
    headers: ghHeaders(opts.accessToken),
  });
  if (list.ok) {
    const hooks = (await list.json()) as Hook[];
    const existing = hooks.find((h) => h.config?.url === url);
    if (existing) return existing.id;
  }

  const res = await fetch(`${GH}/repos/${opts.repoFullName}/hooks`, {
    method: "POST",
    headers: { ...ghHeaders(opts.accessToken), "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "web",
      active: true,
      events: ["push"],
      config: {
        url,
        content_type: "json",
        secret: env.WEBHOOK_SECRET,
        insecure_ssl: "0",
      },
    }),
  });
  if (!res.ok) {
    console.error(`github: register webhook failed (${res.status}):`, await res.text());
    return null;
  }
  const created = (await res.json()) as Hook;
  return created.id;
}

export async function unregisterWebhook(opts: {
  accessToken: string;
  repoFullName: string;
  hookId: number;
}): Promise<void> {
  const res = await fetch(
    `${GH}/repos/${opts.repoFullName}/hooks/${opts.hookId}`,
    {
      method: "DELETE",
      headers: ghHeaders(opts.accessToken),
    }
  );
  if (!res.ok && res.status !== 404) {
    console.error(`github: unregister webhook failed (${res.status})`);
  }
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "deployit",
  };
}
