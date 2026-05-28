export function Login() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center space-y-6">
        <div>
          <h1 className="text-5xl font-bold tracking-tight">DeployIt</h1>
          <p className="text-zinc-400 mt-2">
            Push to GitHub. Get a live URL in 90 seconds.
          </p>
        </div>
        <a
          href="/auth/github"
          className="inline-block bg-white text-zinc-900 font-medium px-6 py-3 rounded-lg hover:bg-zinc-200 transition"
        >
          Sign in with GitHub
        </a>
      </div>
    </div>
  );
}
