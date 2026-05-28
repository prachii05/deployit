import { useEffect, useState } from "react";
import { api, type EnvVar } from "../api";

/**
 * Per-project secret env vars. Stored encrypted on the server (AES-256-GCM);
 * the server never returns the plaintext after creation — only a short masked
 * preview (e.g. "post••••••db") so users can identify which secret is which.
 */
export function EnvVarsPanel({
  projectId,
  projectName,
  onClose,
}: {
  projectId: number;
  projectName: string;
  onClose: () => void;
}) {
  const [items, setItems] = useState<EnvVar[] | null>(null);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const r = await api.envVars(projectId);
      setItems(r.envVars);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    refresh();
  }, [projectId]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.setEnvVar(projectId, key, value);
      setKey("");
      setValue("");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(id: number, k: string) {
    if (!confirm(`Delete env var "${k}"?`)) return;
    await api.deleteEnvVar(projectId, id);
    refresh();
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-10">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="px-5 py-3 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <span className="font-semibold truncate">{projectName}</span>
            <span className="text-xs px-2 py-0.5 rounded bg-purple-700 text-purple-50">
              env vars
            </span>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-white">
            ✕
          </button>
        </div>

        <div className="p-5 overflow-y-auto flex-1">
          <p className="text-sm text-zinc-400 mb-4">
            Set environment variables for this project. Values are encrypted
            at rest and injected into the container on every deploy. Redeploy
            after changes to apply.
          </p>

          <form onSubmit={add} className="flex flex-col gap-2 mb-6">
            <div className="flex gap-2">
              <input
                value={key}
                onChange={(e) => setKey(e.target.value.toUpperCase())}
                placeholder="KEY (e.g. DATABASE_URL)"
                pattern="^[A-Z][A-Z0-9_]*$"
                title="UPPER_SNAKE_CASE"
                required
                className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
              />
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="value"
                type="password"
                required
                className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
              />
              <button
                type="submit"
                disabled={submitting}
                className="bg-white text-zinc-900 px-4 py-2 rounded font-medium text-sm hover:bg-zinc-200 disabled:opacity-50"
              >
                {submitting ? "Saving…" : "Add"}
              </button>
            </div>
            {error && (
              <div className="text-xs text-red-400 bg-red-950/40 border border-red-900 rounded p-2">
                {error}
              </div>
            )}
          </form>

          {!items && <div className="text-zinc-500 text-sm">Loading…</div>}

          {items && items.length === 0 && (
            <div className="text-zinc-500 text-sm italic">
              No env vars yet. Add one above.
            </div>
          )}

          {items && items.length > 0 && (
            <div className="border border-zinc-800 rounded divide-y divide-zinc-800">
              {items.map((v) => (
                <div
                  key={v.id}
                  className="px-4 py-2 flex items-center justify-between gap-2"
                >
                  <div className="flex gap-3 min-w-0 font-mono text-xs">
                    <span className="text-emerald-400">{v.key}</span>
                    <span className="text-zinc-600">=</span>
                    <span className="text-zinc-400 truncate">{v.preview}</span>
                  </div>
                  <button
                    onClick={() => remove(v.id, v.key)}
                    className="text-xs text-zinc-500 hover:text-red-400 shrink-0"
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
