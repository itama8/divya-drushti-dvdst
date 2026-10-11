import { loadProjectConfig, type ProjectConfig } from "../config/config.js";
import { isObject, readJsonl, type SourceRecord } from "../pi/read-jsonl.js";
import { resolveSession, resolveSessions, type ResolveSessionsOptions } from "../pi/resolve-sessions.js";
import { deriveRows, type Row } from "./rows.js";

/** One parsed session: its raw entries and every built-in row stream. */
export interface SessionData {
  /** Session file the data was read from. */
  path: string;
  /** Session id from the header. */
  session: string;
  /** Working directory recorded in the header. */
  cwd: string | null;
  /** Raw entries with the line and byte range of each. */
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
  const records = await readJsonl(path);
  const header = records.map((record) => record.value).find((value) => isObject(value) && value.type === "session");
  const cwd = isObject(header) && typeof header.cwd === "string" ? header.cwd : null;
  const config = await configFor(cwd, options.configPath);
  const rows = deriveRows(records, path, { full: options.full ?? true, commandClasses: config.commandClasses });
  return { path, session: rows.overview.session as string, cwd, records, ...rows, config };
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
