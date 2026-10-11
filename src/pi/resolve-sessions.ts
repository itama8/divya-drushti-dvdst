import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { sessionIdFromFilename } from "./sessions.js";

export type SourceSelection = "pi" | "claude" | "all";

export interface ResolveSessionsOptions {
  /** Session specs: a file, a directory, a session id, an id or timestamp prefix, or `latest`. */
  specs: string[];
  /** Directory that holds session files. Overrides the default lookup. */
  root?: string;
  /** Project directory name or trailing part of it, for example `omakase-v2`. */
  project?: string;
  /** Agent whose sessions `latest`, `--last`, and `--since` select. Defaults to `DVDST_SOURCE`, then `pi`. An id is looked up in every source. */
  source?: SourceSelection;
  /** Keep only the newest N sessions. */
  last?: number;
  /** Keep sessions started at or after this UTC date or timestamp. */
  since?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  home?: string;
}

export class SessionResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionResolveError";
  }
}

interface Candidate {
  path: string;
  filename: string;
  /** Session id, when the filename carries one. */
  id: string | undefined;
  /** ISO start time, used to order sessions from every source on one clock. */
  startedAt: string;
}

interface SourceLayout {
  name: "pi" | "claude";
  base(home: string): string;
  /** Name of the project directory the agent uses for a working directory. */
  directoryFor(cwd: string): string;
  matchesProject(directory: string, project: string): boolean;
}

const LAYOUTS: SourceLayout[] = [
  {
    name: "pi",
    base: (home) => join(home, ".pi", "agent", "sessions"),
    // Pi names a project directory after the working directory, with `/` as `-`.
    directoryFor: (cwd) => `--${resolve(cwd).replace(/^\/+/, "").replace(/\//g, "-")}--`,
    matchesProject: (directory, project) => directory.endsWith(`-${project}--`),
  },
  {
    name: "claude",
    base: (home) => join(home, ".claude", "projects"),
    // Claude Code replaces every character that is not a letter or digit with `-`.
    directoryFor: (cwd) => resolve(cwd).replace(/[^A-Za-z0-9]/g, "-"),
    matchesProject: (directory, project) => directory.endsWith(`-${project.replace(/[^A-Za-z0-9]/g, "-")}`),
  },
];

const PI_FILENAME_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/;
const FIRST_TIMESTAMP = /"timestamp":\s*"(\d{4}-\d{2}-\d{2}T[^"]+)"/;

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isDirectory()).catch(() => false);
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isFile()).catch(() => false);
}

/**
 * A Pi filename states when the session started. Other files state it in
 * their first entries, and the modification time is the last resort.
 */
async function startTime(path: string, filename: string): Promise<string> {
  const named = PI_FILENAME_TIME.exec(filename);
  if (named !== null) return `${named[1]}T${named[2]}:${named[3]}:${named[4]}.${named[5]}Z`;
  const handle = await open(path, "r").catch(() => undefined);
  if (handle !== undefined) {
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const match = FIRST_TIMESTAMP.exec(buffer.subarray(0, bytesRead).toString("utf8"));
      if (match !== null) return match[1]!;
    } finally {
      await handle.close();
    }
  }
  const info = await stat(path).catch(() => undefined);
  return new Date(info?.mtimeMs ?? 0).toISOString();
}

async function candidate(path: string): Promise<Candidate> {
  const filename = basename(path);
  return { path, filename, id: sessionIdFromFilename(filename) ?? filename.replace(/\.jsonl$/, ""), startedAt: await startTime(path, filename) };
}

async function candidatesIn(directories: string[]): Promise<Candidate[]> {
  const found: Candidate[] = [];
  for (const directory of directories) {
    const names = (await readdir(directory).catch(() => [] as string[])).filter((name) => name.endsWith(".jsonl"));
    for (const name of names) {
      const path = join(directory, name);
      const info = await stat(path).catch(() => undefined);
      if (info === undefined || !info.isFile() || info.size === 0) continue;
      found.push(await candidate(path));
    }
  }
  return found.sort(byStart);
}

function byStart(left: Candidate, right: Candidate): number {
  return left.startedAt < right.startedAt ? -1 : left.startedAt > right.startedAt ? 1 : left.path.localeCompare(right.path);
}

async function projectDirectories(home: string, layouts: SourceLayout[]): Promise<string[]> {
  const directories: string[] = [];
  for (const layout of layouts) {
    const names = await readdir(layout.base(home)).catch(() => [] as string[]);
    directories.push(...names.sort().map((name) => join(layout.base(home), name)));
  }
  return directories;
}

function layoutsFor(source: SourceSelection): SourceLayout[] {
  return LAYOUTS.filter((layout) => source === "all" || layout.name === source);
}

interface Roots {
  directories: string[];
  /** True when the roots came from the working directory. */
  implicit: boolean;
  /** Directories to search when an id matches nothing in `directories`. */
  widen?: () => Promise<string[]>;
}

async function sessionRoots(options: ResolveSessionsOptions, home: string, source: SourceSelection): Promise<Roots> {
  const env = options.env ?? process.env;
  if (options.root !== undefined) {
    if (!(await isDirectory(options.root))) throw new SessionResolveError(`--root ${options.root} is not a directory`);
    return { directories: [options.root], implicit: false };
  }
  const layouts = layoutsFor(source);
  if (options.project !== undefined) {
    const wanted = options.project;
    const matches: string[] = [];
    for (const layout of layouts) {
      const names = await readdir(layout.base(home)).catch(() => [] as string[]);
      matches.push(...names.sort().filter((name) => layout.matchesProject(name, wanted)).map((name) => join(layout.base(home), name)));
    }
    if (matches.length === 0) {
      throw new SessionResolveError(`--project ${wanted} matches no directory under ${layouts.map((layout) => layout.base(home)).join(" or ")}`);
    }
    return { directories: matches, implicit: false };
  }
  const configured = env.DVDST_SESSION_ROOT;
  if (configured !== undefined && configured.length > 0) return { directories: [configured], implicit: false };
  const cwd = options.cwd ?? process.cwd();
  const forCwd: string[] = [];
  for (const layout of layouts) {
    const directory = join(layout.base(home), layout.directoryFor(cwd));
    if (await isDirectory(directory)) forCwd.push(directory);
  }
  if (forCwd.length > 0) return { directories: forCwd, implicit: true };
  return { directories: await projectDirectories(home, layouts), implicit: false };
}

function sinceKey(since: string): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(since)) throw new SessionResolveError(`--since ${since} must start with a YYYY-MM-DD date`);
  return since;
}

function matchesSpec(entry: Candidate, spec: string): boolean {
  return entry.filename.startsWith(spec) || (entry.id !== undefined && entry.id.startsWith(spec));
}

async function resolveSpec(spec: string, roots: Roots): Promise<Candidate[]> {
  if (await isFile(spec)) return [await candidate(spec)];
  if (await isDirectory(spec)) return candidatesIn([spec]);

  if (spec === "latest") {
    const newest = (await candidatesIn(roots.directories)).at(-1);
    if (newest === undefined) throw new SessionResolveError(`No session files under ${roots.directories.join(", ")}`);
    return [newest];
  }
  // An id names one session whichever agent wrote it, so the lookup covers
  // every source: first the projects of the working directory, then all of them.
  let matches = (await candidatesIn(roots.directories)).filter((entry) => matchesSpec(entry, spec));
  if (matches.length === 0 && roots.widen !== undefined) {
    matches = (await candidatesIn(await roots.widen())).filter((entry) => matchesSpec(entry, spec));
  }
  if (matches.length === 1) return matches;
  if (matches.length === 0) {
    throw new SessionResolveError(
      `No session matches ${JSON.stringify(spec)}. Pass a session file, a directory, a session id or id prefix, a filename timestamp prefix, or "latest". Use --root <dir> or --project <name> to choose where to look, and --source claude for Claude Code sessions.`,
    );
  }
  const shown = matches.slice(-5).map((entry) => `  ${entry.filename}`).join("\n");
  throw new SessionResolveError(`${JSON.stringify(spec)} matches ${matches.length} sessions; use a longer prefix. Newest matches:\n${shown}`);
}

function selectedSource(options: ResolveSessionsOptions): SourceSelection {
  const value = options.source ?? (options.env ?? process.env).DVDST_SOURCE ?? "pi";
  if (value !== "pi" && value !== "claude" && value !== "all") throw new SessionResolveError(`--source must be pi, claude, or all, not ${JSON.stringify(value)}`);
  return value;
}

/**
 * Resolves session specs to session file paths, oldest first.
 *
 * Every command that reads a session accepts the same specs, so a caller can
 * pass whatever it has: `$PI_SESSION_FILE`, an id copied from a log, or
 * `latest`. With no spec, `--last` and `--since` select from the session
 * directory, and `PI_SESSION_FILE` names the current session. `latest`,
 * `--last`, and `--since` select from one agent's sessions unless `--source
 * all` is given; an id is looked up across every agent.
 */
export async function resolveSessions(options: ResolveSessionsOptions): Promise<string[]> {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const source = selectedSource(options);
  const selecting = options.last !== undefined || options.since !== undefined || options.root !== undefined || options.project !== undefined || options.source !== undefined;
  if (options.last !== undefined && (!Number.isSafeInteger(options.last) || options.last < 1)) {
    throw new SessionResolveError("--last must be a whole number of at least 1");
  }

  let candidates: Candidate[];
  if (options.specs.length > 0) {
    const roots = await sessionRoots(options, home, source);
    const explicit = options.root !== undefined || options.project !== undefined || options.source !== undefined;
    // `latest` stays inside the selected source; an id search may cross sources.
    const idRoots: Roots = explicit
      ? roots
      : { ...(await sessionRoots(options, home, "all")), widen: () => projectDirectories(home, LAYOUTS) };
    const seen = new Set<string>();
    candidates = [];
    for (const spec of options.specs) {
      for (const entry of await resolveSpec(spec, spec === "latest" ? roots : idRoots)) {
        if (!seen.has(entry.path)) {
          seen.add(entry.path);
          candidates.push(entry);
        }
      }
    }
  } else if (selecting) {
    candidates = await candidatesIn((await sessionRoots(options, home, source)).directories);
  } else {
    const current = env.PI_SESSION_FILE;
    if (current === undefined || current.length === 0) {
      throw new SessionResolveError('No session given. Pass a session file, id, id prefix, or "latest", or select several with --last <n> or --since <date>.');
    }
    return [current];
  }

  if (options.since !== undefined) {
    const key = sinceKey(options.since);
    candidates = candidates.filter((entry) => entry.startedAt >= key);
  }
  if (options.last !== undefined) candidates = candidates.slice(-options.last);
  return candidates.map((entry) => entry.path);
}

/** Resolves a spec that must name exactly one session. */
export async function resolveSession(spec: string | undefined, options: Omit<ResolveSessionsOptions, "specs"> = {}): Promise<string> {
  const paths = await resolveSessions({ ...options, specs: spec === undefined ? [] : [spec] });
  if (paths.length !== 1) {
    throw new SessionResolveError(`Expected one session, but ${JSON.stringify(spec ?? "")} resolves to ${paths.length}. Name one session file or id.`);
  }
  return paths[0]!;
}
