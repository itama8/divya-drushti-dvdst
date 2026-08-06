import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

export interface SessionCandidate {
  path: string;
  filename: string;
  bytes: number;
  modified: number;
  directory: string;
  project: string;
}

const PI_DIR_RE = /^--(.+)--$/;
const PI_FILE_RE = /^(\d{4}-\d{2}-\d{2}T[\d-]+Z)_(.+)\.jsonl$/;

function safeStat(path: string): Promise<{ size: number; mtimeMs: number } | undefined> {
  return stat(path)
    .then((result) => ({ size: result.size, mtimeMs: result.mtimeMs }))
    .catch(() => undefined);
}

async function* walkPaths(paths: string[]): AsyncGenerator<string> {
  for (const input of paths) {
    const info = await safeStat(input);
    if (!info) continue;
    if (info.size === 0 && input.endsWith(".jsonl")) continue;
    yield input;
  }
}

function projectFromDirectory(directory: string): string {
  const match = PI_DIR_RE.exec(basename(directory));
  return match?.[1]?.replace(/-/g, "/") ?? basename(directory);
}

function isSessionFile(name: string): boolean {
  return PI_FILE_RE.test(name) && name.endsWith(".jsonl");
}

async function discoverInDirectory(directory: string): Promise<SessionCandidate[]> {
  const entries = await readdir(directory).catch(() => []);
  const candidates: SessionCandidate[] = [];
  for (const entry of entries) {
    if (!isSessionFile(entry)) continue;
    const path = join(directory, entry);
    const info = await safeStat(path);
    if (!info) continue;
    candidates.push({ path, filename: entry, bytes: info.size, modified: info.mtimeMs, directory, project: projectFromDirectory(directory) });
  }
  return candidates;
}

export async function discoverSessions(paths: string[]): Promise<SessionCandidate[]> {
  const found: SessionCandidate[] = [];
  for await (const input of walkPaths(paths)) {
    const info = await stat(input).catch(() => undefined);
    if (!info) continue;
    if (info.isDirectory()) {
      found.push(...(await discoverInDirectory(input)));
      continue;
    }
    if (info.isFile() && isSessionFile(input.split("/").pop() ?? "")) {
      const directory = input.split("/").slice(0, -1).join("/") || ".";
      found.push({ path: input, filename: input.split("/").pop() ?? input, bytes: info.size, modified: info.mtimeMs, directory, project: projectFromDirectory(directory) });
    }
  }
  found.sort((left, right) => right.modified - left.modified);
  return found;
}

export function sessionIdFromFilename(name: string): string | undefined {
  return PI_FILE_RE.exec(name)?.[2];
}
