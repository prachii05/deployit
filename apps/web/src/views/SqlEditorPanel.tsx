import { useState } from "react";
import { api, type QueryResult } from "../api";

/**
 * Built-in SQL editor for a project's provisioned database. Queries run
 * server-side as the project's own Postgres role (isolated to its database),
 * with a statement timeout and row cap enforced by the API.
 */
export function SqlEditorPanel({
  projectId,
  projectName,
  onClose,
}: {
  projectId: number;
  projectName: string;
  onClose: () => void;
}) {
  const [sql, setSql] = useState("SELECT * FROM visits ORDER BY id DESC LIMIT 50;");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const r = await api.runQuery(projectId, sql);
      setResult(r);
    } catch (e) {
      // The API returns the Postgres error message in the response body.
      setError(stripStatus(String(e)));
      setResult(null);
    } finally {
      setRunning(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // Cmd/Ctrl+Enter to run.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      run();
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-10">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-4xl max-h-[88vh] flex flex-col">
        <div className="px-5 py-3 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <span className="font-semibold truncate">{projectName}</span>
            <span className="text-xs px-2 py-0.5 rounded bg-cyan-800 text-cyan-50">
              SQL editor
            </span>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-white">
            ✕
          </button>
        </div>

        <div className="p-5 flex flex-col gap-3 overflow-hidden">
          <textarea
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            rows={5}
            className="w-full bg-zinc-950 border border-zinc-800 rounded p-3 font-mono text-sm text-zinc-100 resize-y focus:outline-none focus:border-cyan-700"
            placeholder="SELECT * FROM your_table;"
          />
          <div className="flex items-center gap-3">
            <button
              onClick={run}
              disabled={running}
              className="bg-white text-zinc-900 px-4 py-1.5 rounded font-medium text-sm hover:bg-zinc-200 disabled:opacity-50"
            >
              {running ? "Running…" : "Run"}
            </button>
            <span className="text-xs text-zinc-500">⌘/Ctrl + Enter</span>
            {result && (
              <span className="text-xs text-zinc-400 ml-auto">
                {result.rowCount} row{result.rowCount === 1 ? "" : "s"} ·{" "}
                {result.durationMs}ms
                {result.truncated && " · showing first 1000"}
              </span>
            )}
          </div>

          {error && (
            <div className="text-sm text-red-300 bg-red-950/40 border border-red-900 rounded p-3 font-mono whitespace-pre-wrap">
              {error}
            </div>
          )}

          {result && !error && (
            <div className="overflow-auto border border-zinc-800 rounded">
              {result.columns.length === 0 ? (
                <div className="p-3 text-sm text-zinc-400 italic">
                  OK — no rows returned.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-zinc-800/60 sticky top-0">
                    <tr>
                      {result.columns.map((c) => (
                        <th
                          key={c}
                          className="text-left px-3 py-1.5 font-medium text-zinc-300 border-b border-zinc-800"
                        >
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, i) => (
                      <tr key={i} className="even:bg-zinc-900/40">
                        {result.columns.map((c) => (
                          <td
                            key={c}
                            className="px-3 py-1.5 font-mono text-xs text-zinc-300 border-b border-zinc-900 align-top"
                          >
                            {fmt(row[c])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function stripStatus(s: string): string {
  // req() throws "400 Bad Request: {json}" — pull out the error message.
  const m = s.match(/\{.*"error":"(.+?)"\}/s);
  return m && m[1] ? m[1].replace(/\\n/g, "\n") : s;
}
