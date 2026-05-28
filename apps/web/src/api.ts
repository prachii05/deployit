export type Me = { id: number; username: string; avatarUrl: string | null };

export type Repo = {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  url: string;
  cloneUrl: string;
  defaultBranch: string;
  updatedAt: string;
  language: string | null;
};

export type Project = {
  id: number;
  userId: number;
  repoFullName: string;
  repoUrl: string;
  slug: string;
  framework: string | null;
  status: "idle" | "deploying" | "live" | "failed" | "sleeping";
  liveDeploymentId: number | null;
  latestDeploymentId: number | null;
  githubWebhookId: number | null;
  createdAt: string;
};

export type RuntimeLogLine = {
  stream: "stdout" | "stderr";
  ts: string | null;
  line: string;
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: "include", ...init });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`${r.status} ${r.statusText}: ${body}`);
  }
  return r.json();
}

export const api = {
  me: () => req<{ user: Me | null }>("/api/me"),
  logout: () =>
    req<{ ok: true }>("/auth/logout", { method: "POST" }),
  repos: () => req<{ repos: Repo[] }>("/api/me/repos"),
  projects: () => req<{ projects: Project[] }>("/api/projects"),
  createProject: (repo: Repo) =>
    req<{ project: Project }>("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoFullName: repo.fullName,
        repoUrl: repo.url,
      }),
    }),
  deleteProject: (id: number) =>
    req<{ ok: true }>(`/api/projects/${id}`, { method: "DELETE" }),
  deploy: (projectId: number) =>
    req<{ deployment: Deployment }>(`/api/projects/${projectId}/deploy`, {
      method: "POST",
    }),
  deployment: (id: number) =>
    req<{ deployment: Deployment }>(`/api/deployments/${id}`),
  deploymentLogs: (id: number, since = 0) =>
    req<{ logs: LogLine[] }>(`/api/deployments/${id}/logs?since=${since}`),
  runtimeLogs: (projectId: number, tail = 200) =>
    req<{ logs: RuntimeLogLine[]; container: string; message?: string }>(
      `/api/projects/${projectId}/runtime-logs?tail=${tail}`
    ),
};

export type Deployment = {
  id: number;
  projectId: number;
  status: "queued" | "building" | "running" | "live" | "failed" | "stopped";
  commitSha: string | null;
  commitMessage: string | null;
  imageTag: string | null;
  containerName: string | null;
  url: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
};

export type LogLine = {
  id: number;
  ts: string;
  line: string;
  stream: "stdout" | "stderr";
};
