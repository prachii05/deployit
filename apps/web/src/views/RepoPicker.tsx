import { useEffect, useMemo, useState } from "react";
import { api, type Repo } from "../api";

export function RepoPicker({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState<number | null>(null);

  useEffect(() => {
    api
      .repos()
      .then((r) => setRepos(r.repos))
      .catch((e) => setError(String(e)));
  }, []);

  const filtered = useMemo(() => {
    if (!repos) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter(
      (r) =>
        r.fullName.toLowerCase().includes(q) ||
        (r.language?.toLowerCase().includes(q) ?? false)
    );
  }, [repos, filter]);

  async function pick(repo: Repo) {
    setCreating(repo.id);
    setError(null);
    try {
      await api.createProject(repo);
      onCreated();
    } catch (e) {
      setError(String(e));
      setCreating(null);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-start justify-center pt-20 z-10">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-2xl max-h-[80vh] flex flex-col">
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
          <h2 className="font-semibold">Import a Git repository</h2>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-white"
          >
            ✕
          </button>
        </div>

        <div className="p-4 border-b border-zinc-800">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search repos…"
            className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm focus:outline-none focus:border-zinc-600"
          />
        </div>

        <div className="overflow-y-auto flex-1">
          {error && (
            <div className="p-4 text-sm text-red-400 border-b border-zinc-800">
              {error}
            </div>
          )}
          {!repos && !error && (
            <div className="p-6 text-zinc-400 text-sm">Loading repos…</div>
          )}
          {repos && filtered.length === 0 && (
            <div className="p-6 text-zinc-400 text-sm">No repos match.</div>
          )}
          {filtered.map((r) => (
            <div
              key={r.id}
              className="px-5 py-3 border-b border-zinc-800 flex items-center justify-between gap-4 hover:bg-zinc-800/30"
            >
              <div className="min-w-0">
                <div className="font-medium text-sm truncate">
                  {r.fullName}
                  {r.private && (
                    <span className="ml-2 text-xs text-zinc-500">private</span>
                  )}
                </div>
                <div className="text-xs text-zinc-500 mt-0.5">
                  {r.language ?? "—"} ·{" "}
                  updated {new Date(r.updatedAt).toLocaleDateString()}
                </div>
              </div>
              <button
                disabled={creating !== null}
                onClick={() => pick(r)}
                className="text-sm bg-white text-zinc-900 px-3 py-1.5 rounded font-medium hover:bg-zinc-200 disabled:opacity-50 shrink-0"
              >
                {creating === r.id ? "Importing…" : "Import"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
