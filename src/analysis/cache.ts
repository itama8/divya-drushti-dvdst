import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isObject } from "../pi/read-jsonl.js";
import { writeAtomic } from "../store/fs-util.js";
import type { SessionRows } from "./rows.js";

/** Source files whose logic decides the rows. A change to any of them makes cached rows stale. */
const ROW_LOGIC = ["rows.ts", "../pi/bash-effects.ts", "../pi/classify-commands.ts", "../sources/claude.ts", "../sources/codex.ts", "../stage/codex-exec.ts", "../sources/read-session.ts"];

export function cacheDirectory(env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.DVDST_CACHE === "off" || env.DVDST_CACHE === "0") return undefined;
  if (env.DVDST_CACHE_DIR !== undefined && env.DVDST_CACHE_DIR.length > 0) return env.DVDST_CACHE_DIR;
  return join(env.XDG_CACHE_HOME !== undefined && env.XDG_CACHE_HOME.length > 0 ? env.XDG_CACHE_HOME : join(homedir(), ".cache"), "dvdst", "rows");
}

let logicStamp: Promise<string> | undefined;

/** Identifies the code that derives rows, so an upgrade or a local edit never serves rows of the old logic. */
function rowLogicStamp(): Promise<string> {
  logicStamp ??= (async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const hash = createHash("sha256");
    for (const file of ROW_LOGIC) {
      const info = await stat(join(here, file)).catch(() => undefined);
      hash.update(`${file}:${info?.size ?? 0}:${info?.mtimeMs ?? 0};`);
    }
    return hash.digest("hex").slice(0, 16);
  })();
  return logicStamp;
}

interface CacheEntry {
  logic: string;
  size: number;
  mtimeMs: number;
  cwd: string | null;
  configSha: string | null;
  source: string;
  rows: SessionRows;
}

function entryPath(directory: string, sessionPath: string): string {
  return join(directory, `${createHash("sha256").update(resolve(sessionPath)).digest("hex")}.json`);
}

/**
 * Returns the cached rows of a session file when the file, the row logic, and
 * the project rules are all unchanged. `configSha` is asked for with the cwd
 * the entry recorded, because the rules belong to the session's project.
 */
export async function readCachedRows(
  sessionPath: string,
  configSha: (cwd: string | null) => Promise<string | null>,
  directory = cacheDirectory(),
): Promise<{ rows: SessionRows; cwd: string | null; source: string } | undefined> {
  if (directory === undefined) return undefined;
  let entry: unknown;
  try {
    entry = JSON.parse(await readFile(entryPath(directory, sessionPath), "utf8"));
  } catch {
    return undefined;
  }
  if (!isObject(entry)) return undefined;
  const cached = entry as unknown as CacheEntry;
  const info = await stat(sessionPath).catch(() => undefined);
  if (info === undefined || cached.size !== info.size || cached.mtimeMs !== info.mtimeMs) return undefined;
  if (cached.logic !== (await rowLogicStamp())) return undefined;
  if (cached.configSha !== (await configSha(cached.cwd))) return undefined;
  return { rows: cached.rows, cwd: cached.cwd, source: cached.source };
}

/** Stores the rows of a session file. One entry per session path, replaced when the session grows. */
export async function writeCachedRows(
  sessionPath: string,
  value: { rows: SessionRows; cwd: string | null; source: string; configSha: string | null },
  directory = cacheDirectory(),
): Promise<void> {
  if (directory === undefined) return;
  try {
    const info = await stat(sessionPath);
    const entry: CacheEntry = { logic: await rowLogicStamp(), size: info.size, mtimeMs: info.mtimeMs, cwd: value.cwd, configSha: value.configSha, source: value.source, rows: value.rows };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeAtomic(entryPath(directory, sessionPath), JSON.stringify(entry));
  } catch {
    // The cache is an optimization. A read-only or full disk must not fail the query.
  }
}

export async function cacheUsage(directory = cacheDirectory()): Promise<{ directory: string | null; entries: number; bytes: number }> {
  if (directory === undefined) return { directory: null, entries: 0, bytes: 0 };
  let entries = 0;
  let bytes = 0;
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    const info = await stat(join(directory, name)).catch(() => undefined);
    if (info === undefined || !info.isFile()) continue;
    entries += 1;
    bytes += info.size;
  }
  return { directory, entries, bytes };
}

export async function clearCache(directory = cacheDirectory()): Promise<void> {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
}
