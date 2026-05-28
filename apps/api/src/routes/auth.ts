import { Router } from "express";
import { eq } from "drizzle-orm";
import { users, sessions } from "@deployit/db";
import { db } from "../db.js";
import { env } from "../env.js";
import { encrypt, randomToken } from "../crypto.js";

export const auth = Router();

const SESSION_COOKIE = "deployit_session";
const SESSION_TTL_DAYS = 30;

auth.get("/github", (req, res) => {
  const state = randomToken(16);
  res.cookie("oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 10 * 60 * 1000,
  });
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.GITHUB_OAUTH_CALLBACK);
  url.searchParams.set("scope", "read:user repo");
  url.searchParams.set("state", state);
  res.redirect(url.toString());
});

auth.get("/github/callback", async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string };
  const cookieState = req.cookies?.oauth_state;
  if (!code || !state || state !== cookieState) {
    return res.status(400).send("invalid oauth state");
  }
  res.clearCookie("oauth_state");

  // Exchange code for access token
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: env.GITHUB_OAUTH_CALLBACK,
    }),
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!tokenJson.access_token) {
    return res.status(400).send(`github oauth failed: ${tokenJson.error ?? "unknown"}`);
  }
  const accessToken = tokenJson.access_token;

  // Fetch user
  const userRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": "deployit" },
  });
  if (!userRes.ok) return res.status(400).send("failed to fetch github user");
  const gh = (await userRes.json()) as {
    id: number;
    login: string;
    avatar_url: string;
  };

  // Upsert user
  const existing = await db.select().from(users).where(eq(users.githubId, gh.id)).limit(1);
  let userId: number;
  if (existing[0]) {
    userId = existing[0].id;
    await db
      .update(users)
      .set({
        username: gh.login,
        avatarUrl: gh.avatar_url,
        accessTokenEncrypted: encrypt(accessToken),
      })
      .where(eq(users.id, userId));
  } else {
    const [created] = await db
      .insert(users)
      .values({
        githubId: gh.id,
        username: gh.login,
        avatarUrl: gh.avatar_url,
        accessTokenEncrypted: encrypt(accessToken),
      })
      .returning({ id: users.id });
    userId = created!.id;
  }

  // Create session
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({ id: token, userId, expiresAt });

  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.WEB_ORIGIN.startsWith("https://"),
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
  res.redirect(env.WEB_ORIGIN);
});

auth.post("/logout", async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    await db.delete(sessions).where(eq(sessions.id, token));
    res.clearCookie(SESSION_COOKIE);
  }
  res.json({ ok: true });
});

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
