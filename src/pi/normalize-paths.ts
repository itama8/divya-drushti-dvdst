import { isAbsolute, relative } from "node:path";

export function normalizeSessionPath(path: string, cwd: unknown): string {
  if (!isAbsolute(path) || typeof cwd !== "string" || !cwd) return path;
  const projectRelative = relative(cwd, path);
  if (projectRelative === "") return ".";
  if (!projectRelative.startsWith("..") && !isAbsolute(projectRelative)) return projectRelative;
  return path;
}
