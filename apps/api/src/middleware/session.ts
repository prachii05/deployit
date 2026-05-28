import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { sessions, users, type User } from "@deployit/db";
import { db } from "../db.js";
import { SESSION_COOKIE_NAME } from "../routes/auth.js";

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export async function loadSession(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  if (!token) return next();
  const rows = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, token))
    .limit(1);
  const row = rows[0];
  if (row) req.user = row.user;
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "unauthorized" });
  next();
}
