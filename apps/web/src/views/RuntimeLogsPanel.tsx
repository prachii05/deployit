import { useEffect, useRef, useState } from "react";
import { api, type RuntimeLogLine } from "../api";

/**
 * Tails `docker logs` on the project's live container. Polls every 2s.
 * Unlike build logs, these are read directly from Docker — they persist as
 * long as the container is alive.
 */
export function RuntimeLogsPanel({
  projectId,
  projectName,
  onClose,
}: {
  projectId: number;
  projectName: string;
  onClose: () => void;
}) {
  const [lines, setLines] = useState<RuntimeLogLine[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [containerName, setContainerName] = useState<string>("");
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      while (!cancelled) {
        try {
          const r = await api.runtimeLogs(projectId, 300);
          if (cancelled) return;
          setLines(r.logs);
          setContainerName(r.container);
          setMessage(r.message ?? null);
        } catch (e) {
          setMessage(String(e));
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    poll();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Auto-scroll to bottom as new logs come in.
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines.length]);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-10">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-3xl h-[80vh] flex flex-col">
        <div className="px-5 py-3 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <span className="font-semibold truncate">{projectName}</span>
            <span className="text-xs px-2 py-0.5 rounded bg-blue-700 text-blue-50">
              runtime logs
            </span>
            {containerName && (
              <span className="text-xs text-zinc-500 truncate">{containerName}</span>
            )}
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-white">
            ✕
          </button>
        </div>

        <div
          ref={containerRef}
          className="flex-1 overflow-y-auto p-4 font-mono text-xs bg-black"
        >
          {lines.length === 0 && !message && (
            <div className="text-zinc-500">Waiting for output…</div>
          )}
          {message && (
            <div className="text-yellow-400 mb-2">{message}</div>
          )}
          {lines.map((l, i) => (
            <div
              key={i}
              className={l.stream === "stderr" ? "text-red-300" : "text-zinc-200"}
            >
              {l.ts && (
                <span className="text-zinc-600 mr-2">
                  {new Date(l.ts).toLocaleTimeString()}
                </span>
              )}
              {l.line}
            </div>
          ))}
        </div>
        <div className="px-5 py-2 border-t border-zinc-800 text-xs text-zinc-500">
          Polling every 2s · last 300 lines
        </div>
      </div>
    </div>
  );
}
