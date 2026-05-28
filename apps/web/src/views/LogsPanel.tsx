import { useEffect, useRef, useState } from "react";
import { api, type Deployment, type LogLine } from "../api";

const TERMINAL_STATUSES = new Set<Deployment["status"]>([
  "live",
  "failed",
  "stopped",
]);

export function LogsPanel({
  deploymentId,
  onClose,
  onSettled,
}: {
  deploymentId: number;
  onClose: () => void;
  onSettled: () => void;
}) {
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const sinceRef = useRef(0);
  const settledRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      while (!cancelled) {
        try {
          const [d, l] = await Promise.all([
            api.deployment(deploymentId),
            api.deploymentLogs(deploymentId, sinceRef.current),
          ]);
          if (cancelled) return;
          setDeployment(d.deployment);
          if (l.logs.length > 0) {
            sinceRef.current = l.logs[l.logs.length - 1]!.id;
            setLogs((prev) => [...prev, ...l.logs]);
          }
          if (TERMINAL_STATUSES.has(d.deployment.status)) {
            if (!settledRef.current) {
              settledRef.current = true;
              onSettled();
            }
            await new Promise((r) => setTimeout(r, 2500));
          } else {
            await new Promise((r) => setTimeout(r, 1000));
          }
        } catch {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }
    poll();
    return () => {
      cancelled = true;
    };
  }, [deploymentId, onSettled]);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs.length]);

  const status = deployment?.status ?? "queued";

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-10">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-3xl h-[80vh] flex flex-col">
        <div className="px-5 py-3 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="font-semibold">Deployment #{deploymentId}</span>
            <span className={`text-xs px-2 py-0.5 rounded ${statusClass(status)}`}>
              {status}
            </span>
            {deployment?.url && (
              <a
                href={deployment.url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-blue-400 hover:underline"
              >
                {deployment.url} ↗
              </a>
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
          {logs.length === 0 && (
            <div className="text-zinc-500">Waiting for logs…</div>
          )}
          {logs.map((l) => (
            <div
              key={l.id}
              className={l.stream === "stderr" ? "text-red-300" : "text-zinc-200"}
            >
              {l.line}
            </div>
          ))}
          {deployment?.error && (
            <div className="text-red-400 mt-2">Error: {deployment.error}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function statusClass(s: Deployment["status"]): string {
  switch (s) {
    case "live":
      return "bg-green-700 text-green-50";
    case "failed":
      return "bg-red-700 text-red-50";
    case "building":
    case "running":
      return "bg-blue-700 text-blue-50";
    case "stopped":
      return "bg-zinc-700 text-zinc-200";
    default:
      return "bg-yellow-700 text-yellow-50";
  }
}
