import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  jsonb,
  pgEnum,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const deploymentStatus = pgEnum("deployment_status", [
  "queued",
  "building",
  "running",
  "live",
  "failed",
  "stopped",
]);

export const projectStatus = pgEnum("project_status", [
  "idle",
  "deploying",
  "live",
  "failed",
  "sleeping",
]);

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    githubId: integer("github_id").notNull(),
    username: text("username").notNull(),
    avatarUrl: text("avatar_url"),
    accessTokenEncrypted: text("access_token_encrypted").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    githubIdIdx: uniqueIndex("users_github_id_idx").on(t.githubId),
  })
);

export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  repoFullName: text("repo_full_name").notNull(), // "owner/repo"
  repoUrl: text("repo_url").notNull(),
  slug: text("slug").notNull().unique(), // subdomain: my-app-abc123
  framework: text("framework"), // detected on first deploy
  status: projectStatus("status").default("idle").notNull(),
  liveDeploymentId: integer("live_deployment_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const deployments = pgTable("deployments", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  status: deploymentStatus("status").default("queued").notNull(),
  commitSha: text("commit_sha"),
  commitMessage: text("commit_message"),
  imageTag: text("image_tag"),
  containerName: text("container_name"),
  url: text("url"),
  error: text("error"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
});

export const deploymentLogs = pgTable("deployment_logs", {
  id: serial("id").primaryKey(),
  deploymentId: integer("deployment_id")
    .references(() => deployments.id, { onDelete: "cascade" })
    .notNull(),
  ts: timestamp("ts").defaultNow().notNull(),
  line: text("line").notNull(),
  stream: text("stream").default("stdout").notNull(),
});

export const envVars = pgTable("env_vars", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  key: text("key").notNull(),
  valueEncrypted: text("value_encrypted").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const databases = pgTable("databases", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull()
    .unique(),
  containerName: text("container_name").notNull(),
  connectionStringEncrypted: text("connection_string_encrypted").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // random token
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type Deployment = typeof deployments.$inferSelect;
export type Session = typeof sessions.$inferSelect;
