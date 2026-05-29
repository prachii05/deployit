import { useEffect, useState } from "react";
import { api } from "../api";

type State = "loading" | "none" | "has_db" | "provisioning" | "error";

export function DatabaseButton({
  projectId,
  onProvisioned,
  onOpenSql,
}: {
  projectId: number;
  onProvisioned: () => void;
  onOpenSql: () => void;
}) {
  const [state, setState] = useState<State>("loading");
  const [neonEnabled, setNeonEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.dbStatus(projectId).then((r) => {
      setNeonEnabled(r.neonEnabled);
      setState(r.hasDatabase ? "has_db" : "none");
    }).catch(() => setState("none"));
  }, [projectId]);

  async function add() {
    setState("provisioning");
    setError(null);
    try {
      await api.addDatabase(projectId);
      setState("has_db");
      onProvisioned();
    } catch (e) {
      setError(String(e));
      setState("none");
    }
  }

  async function remove() {
    if (!confirm("Delete this project's database? All data will be lost.")) return;
    try {
      await api.removeDatabase(projectId);
      setState("none");
      onProvisioned();
    } catch (e) {
      setError(String(e));
    }
  }

  if (!neonEnabled || state === "loading") return null;

  return (
    <div className="flex items-center gap-2">
      {state === "has_db" && (
        <>
          <span className="text-xs px-2 py-0.5 rounded bg-emerald-900 text-emerald-300">
            DB connected
          </span>
          <button
            onClick={onOpenSql}
            className="text-xs text-cyan-400 hover:underline"
          >
            SQL editor
          </button>
          <button
            onClick={remove}
            className="text-xs text-zinc-500 hover:text-red-400"
          >
            Remove DB
          </button>
        </>
      )}
      {(state === "none" || state === "error") && (
        <button
          onClick={add}
          className="text-xs text-cyan-400 hover:underline"
          title="Provision a free Neon Postgres database and auto-inject DATABASE_URL"
        >
          + Add Database
        </button>
      )}
      {state === "provisioning" && (
        <span className="text-xs text-zinc-400 animate-pulse">
          Provisioning DB…
        </span>
      )}
      {error && (
        <span className="text-xs text-red-400 truncate max-w-xs" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
