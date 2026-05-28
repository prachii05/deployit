import fs from "node:fs";
import path from "node:path";

export type Framework = "nextjs" | "node" | "static" | "unknown";

export function detectFramework(repoDir: string): Framework {
  const pkgPath = path.join(repoDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      if (deps["next"]) return "nextjs";
      return "node";
    } catch {
      return "node";
    }
  }
  if (
    fs.existsSync(path.join(repoDir, "index.html")) ||
    fs.existsSync(path.join(repoDir, "public", "index.html"))
  ) {
    return "static";
  }
  return "unknown";
}
