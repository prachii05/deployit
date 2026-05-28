import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Framework } from "./detect.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, "..", "templates");

const map: Record<Exclude<Framework, "unknown">, string> = {
  static: "static.Dockerfile",
  node: "node.Dockerfile",
  nextjs: "nextjs.Dockerfile",
};

export function writeDockerfile(repoDir: string, fw: Framework): void {
  if (fw === "unknown") {
    throw new Error("could not detect framework — no Dockerfile template");
  }
  const existing = path.join(repoDir, "Dockerfile");
  if (fs.existsSync(existing)) return; // respect user's Dockerfile
  const tpl = fs.readFileSync(path.join(TEMPLATES_DIR, map[fw]), "utf8");
  fs.writeFileSync(existing, tpl);
}

export function exposedPortFor(fw: Framework): number {
  return fw === "static" ? 80 : 3000;
}
