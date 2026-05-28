import { Router } from "express";
import { requireAuth } from "../middleware/session.js";
import { decrypt } from "../crypto.js";

export const me = Router();

me.get("/", (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      avatarUrl: req.user.avatarUrl,
    },
  });
});

// Stub for Week 2 — list user's GitHub repos
me.get("/repos", requireAuth, async (req, res) => {
  const token = decrypt(req.user!.accessTokenEncrypted);
  const r = await fetch(
    "https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner",
    {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "deployit" },
    }
  );
  if (!r.ok) return res.status(502).json({ error: "github api error" });
  const repos = (await r.json()) as Array<{
    id: number;
    name: string;
    full_name: string;
    private: boolean;
    html_url: string;
    clone_url: string;
    default_branch: string;
    updated_at: string;
    language: string | null;
  }>;
  res.json({
    repos: repos.map((r) => ({
      id: r.id,
      name: r.name,
      fullName: r.full_name,
      private: r.private,
      url: r.html_url,
      cloneUrl: r.clone_url,
      defaultBranch: r.default_branch,
      updatedAt: r.updated_at,
      language: r.language,
    })),
  });
});
