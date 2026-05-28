import type { Me } from "../api";

export function Header({
  me,
  onSignOut,
}: {
  me: Me;
  onSignOut: () => void;
}) {
  return (
    <header className="border-b border-zinc-800 px-6 py-4 flex items-center justify-between">
      <h1 className="text-xl font-bold">DeployIt</h1>
      <div className="flex items-center gap-3">
        {me.avatarUrl && (
          <img src={me.avatarUrl} alt="" className="w-8 h-8 rounded-full" />
        )}
        <span className="text-sm text-zinc-300">{me.username}</span>
        <button
          onClick={onSignOut}
          className="text-sm text-zinc-400 hover:text-white"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
