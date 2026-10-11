import { loadProjectConfig, type ProjectConfig } from "../config/config.js";
import { isObject, type SourceRecord } from "../pi/read-jsonl.js";
import { readSessionRecords, type SessionSource } from "../sources/read-session.js";
import { resolveSession, resolveSessions, type ResolveSessionsOptions } from "../pi/resolve-sessions.js";
import { readCachedRows, writeCachedRows } from "./cache.js";
import { deriveRows, type Row, type SessionRows } from "./rows.js";

/** One parsed session: its raw entries and every built-in row stream. */
export interface SessionData {
  /** Agent that wrote the session. */
  source: SessionSource;
  /** Session file the data was read from. */
  path: string;
  /** Session id from the header. */
  session: string;
  /** Working directory recorded in the header. */
  cwd: string | null;
  /** Entries with the line and byte range of each. A Claude Code session is converted to the Pi entry shape. */
  records: SourceRecord[];
  overview: Row;
  turns: Row[];
  calls: Row[];
  context: Row[];
  /** Project rules that classified the commands. */
  config: ProjectConfig;
}

export interface LoadSessionOptions {
  /** Add arguments and result text to call rows and section text to context rows. Defaults to true. */
  full?: boolean;
  /** Project rules file. Defaults to `.dvdst/config.json` in the session cwd. */
  configPath?: string;
}

const configs = new Map<string, Promise<ProjectConfig>>();

/** Sessions of one project share its rules, so the file is read once per run. */
function configFor(cwd: string | null, configPath: string | undefined): Promise<ProjectConfig> {
  const key = `${configPath ?? ""}\u0000${cwd ?? ""}`;
  let config = configs.get(key);
  if (config === undefined) {
    config = loadProjectConfig({ cwd, configPath });
    configs.set(key, config);
  }
  return config;
}

/** Reads one session file and derives its rows. */
export async function loadSessionFile(path: string, options: LoadSessionOptions = {}): Promise<SessionData> {
  const { source, records, lines } = await readSessionRecords(path);
  const header = records.map((record) => record.value).find((value) => isObject(value) && value.type === "session");
  const cwd = isObject(header) && typeof header.cwd === "string" ? header.cwd : null;
  const config = await configFor(cwd, options.configPath);
  const rows = deriveRows(records, path, { full: options.full ?? true, commandClasses: config.commandClasses });
  rows.overview.lines = lines;
  return { source, path, session: rows.overview.session as string, cwd, records, ...rows, config };
}

/**
 * Returns the built-in rows of one session file, without arguments or result
 * text. Rows are cached per session file and reused while the file, the row
 * logic, and the project rules are unchanged, so a repeated query over a
 * corpus does not parse every session again.
 */
export async function loadSessionRows(path: string, options: { configPath?: string; cache?: boolean } = {}): Promise<SessionRows> {
  const useCache = options.cache !== false;
  if (useCache) {
    const cached = await readCachedRows(path, async (cwd) => (await configFor(cwd, options.configPath)).sha256);
    if (cached !== undefined) return cached.rows;
  }
  const session = await loadSessionFile(path, { full: false, ...(options.configPath === undefined ? {} : { configPath: options.configPath }) });
  const rows: SessionRows = { overview: session.overview, turns: session.turns, calls: session.calls, context: session.context };
  if (useCache) await writeCachedRows(path, { rows, cwd: session.cwd, source: session.source, configSha: session.config.sha256 });
  return rows;
}

/**
 * Loads one session named by a file, a session id or id prefix, a filename
 * timestamp prefix, or `latest`. With no spec it loads `PI_SESSION_FILE`.
 */
export async function loadSession(spec?: string, options: LoadSessionOptions & Omit<ResolveSessionsOptions, "specs"> = {}): Promise<SessionData> {
  return loadSessionFile(await resolveSession(spec, options), options);
}

/**
 * Loads the selected sessions one at a time, oldest first, so a corpus never
 * has to fit in memory at once.
 */
export async function* loadSessions(selection: Partial<ResolveSessionsOptions> & LoadSessionOptions = {}): AsyncGenerator<SessionData> {
  for (const path of await resolveSessions({ ...selection, specs: selection.specs ?? [] })) {
    yield await loadSessionFile(path, selection);
  }
}
