import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { discoverSessions, sessionIdFromFilename, type SessionCandidate } from "./sessions.js";

export interface ResolveSessionsOptions {
  /** Session specs: a file, a directory, a session id, an id or timestamp prefix, or `latest`. */
  specs: string[];
  /** Directory that holds session files. Overrides the default lookup. */
  root?: string;
  /** Pi project directory name or trailing part of it, for example `omakase-v2`. */
  project?: string;
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

function piSessionsDirectory(home: string): string {
  return join(home, ".pi", "agent", "sessions");
}

/** Pi names a project directory after the working directory, with `/` as `-`. */
function piDirectoryName(cwd: string): string {
  return `--${resolve(cwd).replace(/^\/+/, "").replace(/\//g, "-")}--`;
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isDirectory()).catch(() => false);
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isFile()).catch(() => false);
}

async function projectDirectories(home: string): Promise<string[]> {
  const base = piSessionsDirectory(home);
  const names = await readdir(base).catch(() => [] as string[]);
  return names.sort().map((name) => join(base, name));
}

interface Roots {
  directories: string[];
  /** True when the roots came from the working directory, so a miss may widen to every project. */
  implicit: boolean;
}

async function sessionRoots(options: ResolveSessionsOptions, home: string): Promise<Roots> {
  const env = options.env ?? process.env;
  if (options.root !== undefined) {
    if (!(await isDirectory(options.root))) throw new SessionResolveError(`--root ${options.root} is not a directory`);
    return { directories: [options.root], implicit: false };
  }
  if (options.project !== undefined) {
    const all = await projectDirectories(home);
    const wanted = options.project;
    const matches = all.filter((directory) => directory.endsWith(`-${wanted}--`) || directory.endsWith(`/${wanted}`));
    if (matches.length === 0) {
      throw new SessionResolveError(`--project ${wanted} matches no directory under ${piSessionsDirectory(home)}`);
    }
    return { directories: matches, implicit: false };
  }
  const configured = env.DVDST_SESSION_ROOT;
  if (configured !== undefined && configured.length > 0) return { directories: [configured], implicit: false };
  const forCwd = join(piSessionsDirectory(home), piDirectoryName(options.cwd ?? process.cwd()));
  if (await isDirectory(forCwd)) return { directories: [forCwd], implicit: true };
  return { directories: await projectDirectories(home), implicit: false };
}

function byFilename(left: SessionCandidate, right: SessionCandidate): number {
  return left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : left.path.localeCompare(right.path);
}

/** Session filenames start with a UTC timestamp that uses `-` in place of `:` and `.`. */
function sinceKey(since: string): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(since)) throw new SessionResolveError(`--since ${since} must start with a YYYY-MM-DD date`);
  return since.replace(/[:.]/g, "-").replace(/Z$/, "");
}

function matchesSpec(candidate: SessionCandidate, spec: string): boolean {
  const id = sessionIdFromFilename(candidate.filename);
  return candidate.filename.startsWith(spec) || (id !== undefined && id.startsWith(spec));
}

async function resolveSpec(spec: string, roots: Roots, home: string): Promise<string[]> {
  if (await isFile(spec)) return [spec];
  if (await isDirectory(spec)) return (await discoverSessions([spec])).sort(byFilename).map((candidate) => candidate.path);

  let candidates = (await discoverSessions(roots.directories)).sort(byFilename);
  if (spec === "latest") {
    const newest = candidates.at(-1);
    if (newest === undefined) throw new SessionResolveError(`No session files under ${roots.directories.join(", ")}`);
    return [newest.path];
  }
  let matches = candidates.filter((candidate) => matchesSpec(candidate, spec));
  if (matches.length === 0 && roots.implicit) {
    candidates = (await discoverSessions(await projectDirectories(home))).sort(byFilename);
    matches = candidates.filter((candidate) => matchesSpec(candidate, spec));
  }
  if (matches.length === 1) return [matches[0]!.path];
  if (matches.length === 0) {
    throw new SessionResolveError(
      `No session matches ${JSON.stringify(spec)}. Pass a session file, a directory, a session id or id prefix, a filename timestamp prefix, or "latest". Use --root <dir> or --project <name> to choose where to look.`,
    );
  }
  const shown = matches.slice(-5).map((candidate) => `  ${candidate.filename}`).join("\n");
  throw new SessionResolveError(`${JSON.stringify(spec)} matches ${matches.length} sessions; use a longer prefix. Newest matches:\n${shown}`);
}

/**
 * Resolves session specs to session file paths, oldest first.
 *
 * Every command that reads a session accepts the same specs, so a caller can
 * pass whatever it has: `$PI_SESSION_FILE`, an id copied from a log, or
 * `latest`. With no spec, `--last` and `--since` select from the session
 * directory, and `PI_SESSION_FILE` names the current session.
 */
export async function resolveSessions(options: ResolveSessionsOptions): Promise<string[]> {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const selecting = options.last !== undefined || options.since !== undefined || options.root !== undefined || options.project !== undefined;
  if (options.last !== undefined && (!Number.isSafeInteger(options.last) || options.last < 1)) {
    throw new SessionResolveError("--last must be a whole number of at least 1");
  }

  let paths: string[];
  if (options.specs.length > 0) {
    const roots = await sessionRoots(options, home);
    const seen = new Set<string>();
    paths = [];
    for (const spec of options.specs) {
      for (const path of await resolveSpec(spec, roots, home)) {
        if (!seen.has(path)) {
          seen.add(path);
          paths.push(path);
        }
      }
    }
  } else if (selecting) {
    const roots = await sessionRoots(options, home);
    paths = (await discoverSessions(roots.directories)).sort(byFilename).map((candidate) => candidate.path);
  } else {
    const current = env.PI_SESSION_FILE;
    if (current === undefined || current.length === 0) {
      throw new SessionResolveError('No session given. Pass a session file, id, id prefix, or "latest", or select several with --last <n> or --since <date>.');
    }
    paths = [current];
  }

  if (options.since !== undefined) {
    const key = sinceKey(options.since);
    paths = paths.filter((path) => (path.split("/").pop() ?? "") >= key);
  }
  if (options.last !== undefined) paths = paths.slice(-options.last);
  return paths;
}

/** Resolves a spec that must name exactly one session. */
export async function resolveSession(spec: string | undefined, options: Omit<ResolveSessionsOptions, "specs"> = {}): Promise<string> {
  const paths = await resolveSessions({ ...options, specs: spec === undefined ? [] : [spec] });
  if (paths.length !== 1) {
    throw new SessionResolveError(`Expected one session, but ${JSON.stringify(spec ?? "")} resolves to ${paths.length}. Name one session file or id.`);
  }
  return paths[0]!;
}
