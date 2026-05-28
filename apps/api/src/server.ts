import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import { env } from "./env.js";
import { auth } from "./routes/auth.js";
import { me } from "./routes/me.js";
import { projectsRouter } from "./routes/projects.js";
import { deploymentsRouter } from "./routes/deployments.js";
import { loadSession } from "./middleware/session.js";

const app = express();

app.use(
  cors({
    origin: env.WEB_ORIGIN,
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());
app.use(loadSession);

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/auth", auth);
app.use("/api/me", me);
app.use("/api/projects", projectsRouter);
app.use("/api/deployments", deploymentsRouter);

app.listen(env.PORT, () => {
  console.log(`✓ api listening on http://localhost:${env.PORT}`);
});
