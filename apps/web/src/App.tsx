import { useEffect, useState } from "react";
import { api, type Me } from "./api";
import { Login } from "./views/Login";
import { Header } from "./views/Header";
import { Dashboard } from "./views/Dashboard";

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .me()
      .then((j) => setMe(j.user))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-zinc-400">
        Loading…
      </div>
    );
  }

  if (!me) return <Login />;

  return (
    <div className="min-h-screen">
      <Header
        me={me}
        onSignOut={async () => {
          await api.logout();
          location.reload();
        }}
      />
      <Dashboard />
    </div>
  );
}
