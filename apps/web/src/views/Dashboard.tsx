import { useEffect, useState } from "react";
import { api, type Project } from "../api";
import { RepoPicker } from "./RepoPicker";
import { LogsPanel } from "./LogsPanel";
import { RuntimeLogsPanel } from "./RuntimeLogsPanel";
import { EnvVarsPanel } from "./EnvVarsPanel";
import { DatabaseButton } from "./DatabaseButton";
import { SqlEditorPanel } from "./SqlEditorPanel";

const statusStyles: Record<Project["status"], string> = {
  idle: "bg-zinc-700 text-zinc-200",
  deploying: "bg-blue-700 text-blue-50",
  live: "bg-green-700 text-green-50",
  failed: "bg-red-700 text-red-50",
  sleeping: "bg-yellow-700 text-yellow-50",
};

export function Dashboard() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [watchingDeployment, setWatchingDeployment] = useState<number | null>(null);
  const [runtimeLogsFor, setRuntimeLogsFor] = useState<Project | null>(null);
  const [envVarsFor, setEnvVarsFor] = useState<Project | null>(null);
  const [sqlEditorFor, setSqlEditorFor] = useState<Project | null>(null);
  const [deployingId, setDeployingId] = useState<number | null>(null);

  async function refresh() {
    try {
      const r = await api.projects();
      setProjects(r.projects);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function remove(id: number) {
    if (!confirm("Delete this project?")) return;
    await api.deleteProject(id);
    refresh();
  }

  async function deploy(id: number) {
    setDeployingId(id);
    setError(null);
    try {
      const r = await api.deploy(id);
      setWatchingDeployment(r.deployment.id);
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setDeployingId(null);
    }
  }

  async function toggleSleep(p: Project) {
    setError(null);
    try {
      if (p.status === "sleeping") {
        await api.wake(p.id);
      } else {
        await api.sleep(p.id);
      }
      refresh();
    } catch (e) {
      // If wake fails because container is gone, prompt to redeploy.
      const msg = String(e);
      if (msg.includes("redeploy")) {
        if (confirm("Container was removed. Redeploy now?")) {
          await deploy(p.id);
        }
      } else {
        setError(msg);
      }
    }
  }

  return (
    <main className="p-6">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-semibold">Your projects</h2>
          <button
            onClick={() => setPicking(true)}
            className="bg-white text-zinc-900 font-medium px-4 py-2 rounded hover:bg-zinc-200 text-sm"
          >
            + New project
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-900/30 border border-red-800 rounded text-sm text-red-200">
            {error}
          </div>
        )}

        {!projects && !error && (
          <div className="text-zinc-400">Loading…</div>
        )}

        {projects && projects.length === 0 && (
          <div className="rounded-lg border border-zinc-800 p-8 text-center text-zinc-400">
            No projects yet. Click <b>New project</b> to import a repo.
          </div>
        )}

        {projects && projects.length > 0 && (
          <div className="rounded-lg border border-zinc-800 divide-y divide-zinc-800">
            {projects.map((p) => (
              <div
                key={p.id}
                className="px-5 py-4 flex items-center justify-between gap-4"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{p.repoFullName}</span>
                    <span
                      className={`text-xs px-2 py-0.5 rounded ${statusStyles[p.status]}`}
                    >
                      {p.status}
                    </span>
                  </div>
                  <div className="text-xs text-zinc-500 mt-1 flex items-center gap-2">
                    <span>{p.slug}.deployit.app</span>
                    {p.framework && <span>· {p.framework}</span>}
                    {p.githubWebhookId && (
                      <span
                        title="Auto-deploys on every push to default branch"
                        className="text-emerald-400"
                      >
                        ⚡ push-to-deploy
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1">
                    {p.latestDeploymentId && (
                      <button
                        onClick={() => setWatchingDeployment(p.latestDeploymentId!)}
                        className="text-xs text-blue-400 hover:underline"
                      >
                        Build logs
                      </button>
                    )}
                    {p.status === "live" && (
                      <button
                        onClick={() => setRuntimeLogsFor(p)}
                        className="text-xs text-emerald-400 hover:underline"
                      >
                        Runtime logs
                      </button>
                    )}
                    <button
                      onClick={() => setEnvVarsFor(p)}
                      className="text-xs text-purple-400 hover:underline"
                    >
                      Env vars
                    </button>
                    <DatabaseButton
                      projectId={p.id}
                      onProvisioned={refresh}
                      onOpenSql={() => setSqlEditorFor(p)}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => deploy(p.id)}
                    disabled={deployingId !== null || p.status === "deploying"}
                    className="text-sm bg-white text-zinc-900 px-3 py-1.5 rounded font-medium hover:bg-zinc-200 disabled:opacity-50"
                  >
                    {deployingId === p.id
                      ? "Starting…"
                      : p.status === "deploying"
                        ? "Deploying…"
                        : "Deploy"}
                  </button>
                  {(p.status === "live" || p.status === "sleeping") && (
                    <button
                      onClick={() => toggleSleep(p)}
                      title={
                        p.status === "sleeping"
                          ? "Start the container"
                          : "Stop the container to free RAM"
                      }
                      className="text-sm text-zinc-300 hover:text-white border border-zinc-700 px-3 py-1.5 rounded"
                    >
                      {p.status === "sleeping" ? "Wake" : "Sleep"}
                    </button>
                  )}
                  <button
                    onClick={() => remove(p.id)}
                    className="text-sm text-zinc-400 hover:text-red-400 px-2 py-1.5"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {picking && (
        <RepoPicker
          onClose={() => setPicking(false)}
          onCreated={() => {
            setPicking(false);
            refresh();
          }}
        />
      )}

      {watchingDeployment !== null && (
        <LogsPanel
          deploymentId={watchingDeployment}
          onClose={() => setWatchingDeployment(null)}
          onSettled={refresh}
        />
      )}

      {runtimeLogsFor && (
        <RuntimeLogsPanel
          projectId={runtimeLogsFor.id}
          projectName={runtimeLogsFor.repoFullName}
          onClose={() => setRuntimeLogsFor(null)}
        />
      )}

      {envVarsFor && (
        <EnvVarsPanel
          projectId={envVarsFor.id}
          projectName={envVarsFor.repoFullName}
          onClose={() => setEnvVarsFor(null)}
        />
      )}

      {sqlEditorFor && (
        <SqlEditorPanel
          projectId={sqlEditorFor.id}
          projectName={sqlEditorFor.repoFullName}
          onClose={() => setSqlEditorFor(null)}
        />
      )}
    </main>
  );
}
