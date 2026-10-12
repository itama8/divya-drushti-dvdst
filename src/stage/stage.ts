import { spawnSync } from "node:child_process";
import { mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { LiveDecomposer, LiveEventError, parseLiveEvent, type LiveEvent } from "../live/decompose.js";
import type { SourceRecord } from "../pi/read-jsonl.js";
import { claudeToCanonical } from "../sources/claude.js";
import { detectSource } from "../sources/read-session.js";

const LIMIT = "Exact successful edits from one session or an explicit HEAD-pinned manifest are replayed from HEAD. Writes are allowed only for paths absent from HEAD. Unrelated staged changes, ambiguous anchors, and conflicts block the entire operation. Bash warnings are heuristic, not attribution. After committing, start a new session for further edits.";

const MAX_BASH_WARNINGS = 20;
const MAX_COMMAND_PREVIEW = 160;

export interface StageEdit {
  oldText: string;
  newText: string;
}

export interface StagePatch {
  path: string;
  operation: "edit" | "write";
  edits: StageEdit[];
  content: string | undefined;
  sourceEventId: string;
  resultEventId: string;
}

export interface BashCandidate {
  command: string;
  toolCallId: string;
  sourceEventId: string;
}

export interface BashWarning {
  signals: string[];
  command: string;
  toolCallId: string;
  sourceEventId: string;
}

export interface StageConflict {
  path: string;
  reason: string;
  sourceEventId: string;
}

export interface StageReport {
  schemaVersion: 1;
  kind: "stage";
  sessionId: string;
  source: "live" | "session-file" | "manifest";
  selection?: StageSelection;
  cwd: string;
  root: string;
  dryRun: boolean;
  staged: Array<{ path: string; operation: "edit" | "write"; hunks: number }>;
  unchanged: string[];
  conflicts: StageConflict[];
  excluded: Array<{ path: string; reason: string; sourceEventId: string }>;
  unattributedBash: BashWarning[];
  unattributedBashCount: number;
  limit: string;
}

export type PathPlan =
  | { status: "staged"; content: string; operation: "edit" | "write"; hunks: number }
  | { status: "unchanged" }
  | { status: "conflict"; reason: string; sourceEventId: string };

export interface CollectedStage {
  sessionId: string | undefined;
  cwd: string | undefined;
  patches: StagePatch[];
  bash: BashCandidate[];
}

interface StartedTool {
  toolName: string;
  args: Record<string, unknown>;
  sourceEventId: string;
}

export interface StageSelection {
  manifest: string;
  head: string;
  mutations: Array<{ sessionId: string; sourceEventId: string; resultEventId: string; path: string }>;
}

export interface StageOptions {
  manifest?: string;
  input?: string;
  sessionFile?: string;
  cwd?: string;
  session?: string;
  dryRun?: boolean;
  signal?: AbortSignal;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

const BASH_SIGNALS: Array<{ name: string; pattern: RegExp }> = [
  { name: "heredoc", pattern: /<<-?\s*['"]?[A-Za-z_]/ },
  { name: "redirect", pattern: /(^|[^0-9])>>?\s*[^\s|&;<>()]/ },
  { name: "in-place edit", pattern: /\b(?:sed|perl|ruby)\s+[^|;&]*(?:-i\b|--in-place\b|-pi\b)/ },
  { name: "git apply or patch", pattern: /\b(?:git\s+apply|git\s+am|patch\s+-p|applypatch)\b/ },
  { name: "git worktree rewrite", pattern: /\bgit\s+(?:checkout|restore|reset|stash|clean|revert)\b/ },
  { name: "tee or dd", pattern: /(?:^|[|;&]\s*)(?:tee|dd|truncate)\b/ },
  { name: "remove or move", pattern: /(?:^|[|;&]\s*)(?:rm|mv|cp|install)\s/ },
  { name: "inline script", pattern: /\b(?:python3?|node|perl|ruby)\s+(?:-|<<|-[ec]\b)/ },
  { name: "chmod", pattern: /\bchmod\s/ },
  { name: "package install", pattern: /\b(?:npm|pnpm|yarn)\s+(?:install|ci|add|remove|update)\b/ },
];

// Higher weights survive the warning cap first. Content writers outrank
// tree-only and temporary-file commands so the important entries stay visible.
const SIGNAL_WEIGHT: Record<string, number> = {
  heredoc: 6,
  redirect: 6,
  "git apply or patch": 6,
  "in-place edit": 6,
  "inline script": 5,
  "git worktree rewrite": 4,
  "tee or dd": 4,
  "package install": 3,
  "remove or move": 2,
  chmod: 2,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventId(event: LiveEvent): string {
  return event.eventId ?? `${event.source}:${event.sessionId}:${event.sequence}`;
}

/**
 * Names the reasons a successful bash command may have changed files.
 * This is a warning heuristic, not a path attribution. It never claims that a
 * command wrote a specific file.
 */
export function detectBashSignals(command: string): string[] {
  return BASH_SIGNALS.filter((signal) => signal.pattern.test(command)).map((signal) => signal.name);
}

function signalWeight(signals: string[]): number {
  return Math.max(0, ...signals.map((signal) => SIGNAL_WEIGHT[signal] ?? 0));
}

function commandPreview(command: string): string {
  return command.replace(/\s+/g, " ").trim().slice(0, MAX_COMMAND_PREVIEW);
}

/**
 * Names the reasons a successful bash command may have changed files and ranks
 * the strongest signals first. This is a warning heuristic, not a path
 * attribution. It never claims that a command wrote a specific file.
 */
export function inspectBash(candidates: BashCandidate[]): BashWarning[] {
  const matched = candidates.flatMap((candidate) => {
    const signals = detectBashSignals(candidate.command);
    if (signals.length === 0) return [];
    return [{ signals, command: commandPreview(candidate.command), toolCallId: candidate.toolCallId, sourceEventId: candidate.sourceEventId }];
  });
  return matched.sort((left, right) => signalWeight(right.signals) - signalWeight(left.signals));
}

function editPatch(toolName: string, args: Record<string, unknown>, sourceEventId: string, resultEventId: string): StagePatch | undefined {
  if (toolName === "edit") {
    const path = args.path;
    const rawEdits = args.edits;
    if (typeof path !== "string" || path.length === 0 || !Array.isArray(rawEdits) || rawEdits.length === 0) throw new Error("successful edit has invalid staging evidence");
    const edits: StageEdit[] = [];
    for (const operation of rawEdits) {
      if (isObject(operation) && typeof operation.oldText === "string" && typeof operation.newText === "string") {
        edits.push({ oldText: operation.oldText, newText: operation.newText });
      } else throw new Error("successful edit has invalid replacement evidence");
    }
    return { path, operation: "edit", edits, content: undefined, sourceEventId, resultEventId };
  }
  if (toolName === "write") {
    const path = args.path;
    const content = args.content;
    if (typeof path !== "string" || path.length === 0 || typeof content !== "string") throw new Error("successful write has invalid staging evidence");
    return { path, operation: "write", edits: [], content, sourceEventId, resultEventId };
  }
  return undefined;
}

/**
 * Pairs observe-only live events and keeps the successful edit, write, and
 * bash calls, in result order.
 */
export function collectStagePatches(events: LiveEvent[]): CollectedStage {
  const started = new Map<string, StartedTool>();
  const patches: StagePatch[] = [];
  const bash: BashCandidate[] = [];
  let sessionId: string | undefined;
  let cwd: string | undefined;

  const validator = new LiveDecomposer();
  for (const [index, event] of events.entries()) {
    validator.ingest(event, index + 1);
    if (sessionId !== undefined && event.sessionId !== sessionId) throw new Error("stage input contains multiple session IDs");
    sessionId ??= event.sessionId;
    if (event.type === "session.started" && isObject(event.data) && typeof event.data.cwd === "string") {
      cwd ??= event.data.cwd;
      continue;
    }
    if (event.type === "tool.started" && isObject(event.data)) {
      const { toolCallId, toolName, args } = event.data;
      if (typeof toolCallId === "string" && typeof toolName === "string" && isObject(args)) {
        started.set(toolCallId, { toolName, args, sourceEventId: eventId(event) });
      }
      continue;
    }
    if (event.type !== "tool.finished" || !isObject(event.data)) continue;
    const { toolCallId, isError } = event.data;
    if (typeof toolCallId !== "string") continue;
    const tool = started.get(toolCallId);
    started.delete(toolCallId);
    if (tool === undefined || isError !== false) continue;
    const patch = editPatch(tool.toolName, tool.args, tool.sourceEventId, eventId(event));
    if (patch !== undefined) {
      patches.push(patch);
      continue;
    }
    if (tool.toolName === "bash" && typeof tool.args.command === "string") {
      bash.push({ command: tool.args.command, toolCallId, sourceEventId: tool.sourceEventId });
    }
  }

  return { sessionId, cwd, patches, bash };
}

/**
 * Converts a Claude Code transcript to the entry shape the collector reads.
 * Entries of a second session ID mean inherited history, which a fork would
 * stage as its own work, so they are refused like a forked Pi session file.
 * Subagent sidechain entries are left out and their mutations are not staged.
 */
function claudeStageEntries(records: SourceRecord[]): unknown[] {
  const sessionIds = new Set<string>();
  for (const { value } of records) {
    if (isObject(value) && value.isSidechain !== true && typeof value.sessionId === "string") sessionIds.add(value.sessionId);
  }
  if (sessionIds.size > 1) throw new Error("Claude Code transcript contains more than one session ID; inherited mutations cannot be attributed. Start a new session or use an explicit manifest");
  return claudeToCanonical(records).map(record => record.value);
}

/**
 * Reads a Pi session file or a Claude Code transcript and keeps the confirmed
 * successful edit, write, and bash calls. A call with no result is not
 * confirmed and is skipped.
 */
export function collectStageFromSession(text: string): CollectedStage {
  interface SessionCall {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    sourceEventId: string;
    resultEventId: string | undefined;
    isError: boolean | undefined;
  }
  const calls: SessionCall[] = [];
  const completed: SessionCall[] = [];
  const byId = new Map<string, number>();
  let sessionId: string | undefined;
  let cwd: string | undefined;

  const records: SourceRecord[] = [];
  for (const [line, raw] of text.split("\n").entries()) {
    if (raw.trim().length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(raw);
    } catch {
      throw new Error(`invalid session JSON at line ${line + 1}`);
    }
    if (!isObject(entry)) throw new Error(`invalid session record at line ${line + 1}`);
    records.push({ value: entry, source: { line: line + 1, byteStart: 0, byteEnd: 0 } });
  }
  // The same source detection and Claude Code adapter the analysis commands use.
  const entries = detectSource(records) === "claude" ? claudeStageEntries(records) : records.map(({ value }) => value);

  for (const entry of entries) {
    if (!isObject(entry)) continue;
    if (entry.type === "session") {
      if (sessionId !== undefined || typeof entry.id !== "string") throw new Error("session file must contain one session header");
      if (entry.parentSession !== undefined) throw new Error("forked session files contain inherited mutations; use a live stream recorded for this session or start a new session");
      sessionId = entry.id;
      if (typeof entry.cwd === "string") cwd ??= entry.cwd;
      continue;
    }
    if (entry.type !== "message" || !isObject(entry.message)) continue;
    const message = entry.message;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isObject(block) || block.type !== "toolCall") continue;
        if (typeof block.id !== "string" || typeof block.name !== "string" || !isObject(block.arguments)) continue;
        if (byId.has(block.id)) throw new Error(`duplicate session tool call ${block.id}`);
        byId.set(block.id, calls.length);
        calls.push({
          toolCallId: block.id,
          toolName: block.name,
          args: block.arguments,
          sourceEventId: typeof entry.id === "string" ? entry.id : block.id,
          resultEventId: undefined,
          isError: undefined,
        });
      }
      continue;
    }
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const index = byId.get(message.toolCallId);
      if (index !== undefined) {
        if (calls[index]!.isError !== undefined) throw new Error(`duplicate session tool result ${message.toolCallId}`);
        calls[index]!.isError = message.isError === false ? false : true;
        if (typeof entry.id === "string") calls[index]!.resultEventId = entry.id;
        completed.push(calls[index]!);
      }
    }
  }

  const patches: StagePatch[] = [];
  const bash: BashCandidate[] = [];
  for (const call of completed) {
    if (call.isError !== false) continue;
    const patch = editPatch(call.toolName, call.args, call.sourceEventId, call.resultEventId ?? call.sourceEventId);
    if (patch !== undefined) {
      patches.push(patch);
      continue;
    }
    if (call.toolName === "bash" && typeof call.args.command === "string") {
      bash.push({ command: call.args.command, toolCallId: call.toolCallId, sourceEventId: call.sourceEventId });
    }
  }

  return { sessionId, cwd, patches, bash };
}

/**
 * Replays one path's ordered mutations against a known baseline.
 * Every edit in one call matches the same original content. Missing, duplicate,
 * or overlapping anchors conflict. Replay detection belongs to stageChanges,
 * which compares full index content with exact replay states.
 */
export function planPath(original: string | undefined, patches: StagePatch[]): PathPlan {
  if (patches.length === 0) return { status: "unchanged" };

  let work = original;
  let hunks = 0;
  let usedWrite = false;
  for (const patch of patches) {
    if (patch.operation === "write") {
      usedWrite = true;
      if (patch.content === undefined) continue;
      if (work === undefined || patch.content !== work) {
        work = patch.content;
        hunks += 1;
      }
      continue;
    }
    if (work === undefined) {
      return {
        status: "conflict",
        reason: "an edit targets a file that no earlier write created in this session",
        sourceEventId: patch.sourceEventId,
      };
    }
    const replacements: Array<{ from: number; to: number; text: string }> = [];
    for (const edit of patch.edits) {
      if (edit.oldText.length === 0) {
        return { status: "conflict", reason: "an edit anchor is empty", sourceEventId: patch.sourceEventId };
      }
      const first = work.indexOf(edit.oldText);
      if (first === -1) {
        return { status: "conflict", reason: "an edit anchor was not found in the baseline content", sourceEventId: patch.sourceEventId };
      }
      if (work.indexOf(edit.oldText, first + 1) !== -1) {
        return { status: "conflict", reason: "an edit anchor is not unique in the baseline content", sourceEventId: patch.sourceEventId };
      }
      replacements.push({ from: first, to: first + edit.oldText.length, text: edit.newText });
    }
    replacements.sort((a, b) => a.from - b.from);
    for (let i = 1; i < replacements.length; i += 1) {
      if (replacements[i]!.from < replacements[i - 1]!.to) {
        return { status: "conflict", reason: "edit anchors overlap", sourceEventId: patch.sourceEventId };
      }
    }
    for (const replacement of replacements.reverse()) {
      work = `${work.slice(0, replacement.from)}${replacement.text}${work.slice(replacement.to)}`;
      hunks += 1;
    }
  }

  if (work === undefined) return { status: "unchanged" };
  if (original !== undefined && work === original) return { status: "unchanged" };
  return { status: "staged", content: work, operation: usedWrite ? "write" : "edit", hunks };
}

function git(root: string, args: string[], input?: string, indexFile?: string): GitResult {
  const result = spawnSync("git", ["--literal-pathspecs", "-C", root, ...args], {
    encoding: "utf8", input, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...(indexFile === undefined ? {} : { GIT_INDEX_FILE: indexFile }) },
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function requireGit(root: string, args: string[], indexFile?: string): string {
  const result = git(root, args, undefined, indexFile);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return result.stdout;
}

interface GitFile { content: string | undefined; mode: string }

function blob(root: string, object: string): string {
  const result = spawnSync("git", ["-C", root, "cat-file", "blob", object], { maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`cannot read Git blob: ${result.stderr?.toString().trim() || result.error?.message || "unknown error"}`);
  if (result.stdout.includes(0)) throw new Error("binary content is not supported");
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(result.stdout); }
  catch { throw new Error("invalid UTF-8 content is not supported"); }
}

function regularMode(mode: string): void {
  if (mode !== "100644" && mode !== "100755") throw new Error(`unsupported Git mode ${mode}`);
}

export function readIndexFile(root: string, path: string): GitFile {
  const listing = requireGit(root, ["ls-files", "--stage", "-z", "--", path]);
  const entries = listing.split("\u0000").filter(Boolean);
  if (entries.length === 0) return { content: undefined, mode: "100644" };
  const match = /^(\d{6}) ([0-9a-f]+) 0\t/.exec(entries[0]!);
  if (entries.length !== 1 || match === null) throw new Error("unmerged index entries are not supported");
  const mode = match[1]!;
  regularMode(mode);
  return { content: blob(root, match[2]!), mode };
}

function readHeadFile(root: string, head: string | undefined, path: string): GitFile {
  if (head === undefined) return { content: undefined, mode: "100644" };
  const listing = requireGit(root, ["ls-tree", "-z", head, "--", path]);
  if (listing.length === 0) return { content: undefined, mode: "100644" };
  const match = /^(\d{6}) blob ([0-9a-f]+)\t/.exec(listing);
  if (match === null) throw new Error("path is not a regular Git blob");
  const mode = match[1]!;
  regularMode(mode);
  return { content: blob(root, match[2]!), mode };
}

export function writeIndexFile(root: string, path: string, content: string, mode: string, indexFile?: string): void {
  const hashed = git(root, ["hash-object", "-w", "--stdin"], content);
  if (hashed.code !== 0) {
    throw new Error(`git hash-object failed: ${hashed.stderr.trim() || `exit ${hashed.code}`}`);
  }
  const object = hashed.stdout.trim();
  if (!/^[0-9a-f]+$/.test(object)) throw new Error(`git hash-object returned no object for ${path}`);
  requireGit(root, ["update-index", "--add", "--cacheinfo", `${mode},${object},${path}`], indexFile);
}

function bashWarnings(collected: CollectedStage): { warnings: BashWarning[]; count: number } {
  const matched = inspectBash(collected.bash);
  return { warnings: matched.slice(0, MAX_BASH_WARNINGS), count: matched.length };
}

async function collect(options: StageOptions): Promise<{ collected: CollectedStage; source: StageReport["source"]; selection?: StageSelection }> {
  if ([options.input, options.sessionFile, options.manifest].filter(value => value !== undefined).length !== 1) {
    throw new Error("pass exactly one of --input, --session-file, or --manifest");
  }
  if (options.manifest !== undefined) return collectManifest(options.manifest, options.session);
  if (options.input !== undefined) {
    const text = await readFile(options.input, "utf8");
    const events: LiveEvent[] = [];
    let line = 1;
    for (const raw of text.split("\n")) {
      const candidate = raw.replace(/\r$/, "");
      if (candidate.trim().length > 0) {
        const event = parseLiveEvent(candidate, line);
        if (event) events.push(event);
      }
      line += 1;
    }
    return { collected: collectStagePatches(events), source: "live" };
  }
  if (options.sessionFile !== undefined) {
    const text = await readFile(options.sessionFile, "utf8");
    return { collected: collectStageFromSession(text), source: "session-file" };
  }
  throw new Error("pass --input <events.jsonl> or --session-file <session.jsonl>");
}

// The manifest selects entire confirmed calls, never reconstructed patches or
// hunks. Its explicit order can interleave sessions without guessing causality.
async function collectManifest(path: string, callerSession: string | undefined): Promise<{ collected: CollectedStage; source: "manifest"; selection: StageSelection }> {
  if (!callerSession) throw new Error("manifest staging requires --session for the calling session");
  const manifest = resolve(path);
  const value: unknown = JSON.parse(await readFile(manifest, "utf8"));
  if (!isObject(value) || value.schemaVersion !== 1 || typeof value.head !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.head)
    || !Array.isArray(value.sources) || value.sources.length === 0 || !Array.isArray(value.mutations) || value.mutations.length === 0
    || Object.keys(value).some(key => !["schemaVersion", "head", "sources", "mutations"].includes(key))) {
    throw new Error("invalid staging manifest: expected schemaVersion, head, sources, and ordered mutations");
  }
  const sources = new Map<string, CollectedStage>();
  for (const source of value.sources) {
    if (!isObject(source) || (source.kind !== "live" && source.kind !== "session-file") || typeof source.path !== "string" || source.path.length === 0
      || typeof source.sessionId !== "string" || source.sessionId.length === 0 || Object.keys(source).some(key => !["kind", "path", "sessionId"].includes(key))) {
      throw new Error("invalid manifest source");
    }
    if (sources.has(source.sessionId)) throw new Error("duplicate manifest source session");
    const file = resolve(dirname(manifest), source.path);
    const { collected } = await collect(source.kind === "live" ? { input: file } : { sessionFile: file });
    if (collected.sessionId !== source.sessionId) throw new Error("manifest source session ID does not match its evidence");
    // Never reinterpret relative mutation paths using the target repository.
    if (!collected.cwd || !isAbsolute(collected.cwd)) throw new Error("manifest source requires an absolute recorded session cwd");
    sources.set(source.sessionId, collected);
  }
  const selected = new Set<string>();
  const usedSources = new Set<string>();
  const patches: StagePatch[] = [];
  const mutations: StageSelection["mutations"] = [];
  for (const mutation of value.mutations) {
    if (!isObject(mutation) || typeof mutation.sessionId !== "string" || typeof mutation.resultEventId !== "string" || mutation.resultEventId.length === 0
      || Object.keys(mutation).some(key => !["sessionId", "resultEventId"].includes(key))) throw new Error("invalid manifest mutation selector");
    const source = sources.get(mutation.sessionId);
    if (!source) throw new Error("manifest mutation names an unknown source session");
    const matches = source.patches.filter(patch => patch.resultEventId === mutation.resultEventId);
    if (matches.length !== 1) throw new Error(`manifest mutation ${mutation.sessionId}:${mutation.resultEventId} must identify exactly one successful edit or write`);
    const key = JSON.stringify([mutation.sessionId, mutation.resultEventId]);
    if (selected.has(key)) throw new Error("duplicate manifest mutation");
    selected.add(key);
    usedSources.add(mutation.sessionId);
    const patch = matches[0]!;
    const absolute = resolve(source.cwd!, patch.path);
    patches.push({ ...patch, path: absolute, sourceEventId: `${mutation.sessionId}:${patch.sourceEventId}`, resultEventId: `${mutation.sessionId}:${patch.resultEventId}` });
    mutations.push({ sessionId: mutation.sessionId, sourceEventId: patch.sourceEventId, resultEventId: patch.resultEventId, path: absolute });
  }
  if (usedSources.size !== sources.size) throw new Error("manifest contains an unused source session");
  return {
    source: "manifest", selection: { manifest, head: value.head, mutations },
    collected: { sessionId: callerSession, cwd: undefined, patches, bash: [...sources.entries()].flatMap(([sessionId, source]) => source.bash.map(candidate => ({ ...candidate, sourceEventId: `${sessionId}:${candidate.sourceEventId}` }))) },
  };
}

function headId(root: string): string | undefined {
  const result = git(root, ["rev-parse", "--verify", "HEAD"]);
  if (result.code === 0) return result.stdout.trim();
  // Only an unborn branch is an absent baseline. Corrupt refs must fail.
  const branch = git(root, ["symbolic-ref", "-q", "HEAD"]);
  if (branch.code === 0 && git(root, ["show-ref", "--verify", "--quiet", branch.stdout.trim()]).code === 1) return undefined;
  throw new Error("cannot resolve HEAD");
}

async function optionalRead(path: string): Promise<Buffer | undefined> {
  try { return await readFile(path); }
  catch (error) {
    if (isObject(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

// Hold Git's normal index lock, build a private index, then publish it once.
// A conflict or interrupted preparation leaves the original index untouched.
export async function stageChanges(options: StageOptions): Promise<StageReport> {
  options.signal?.throwIfAborted();
  const { collected, source, selection } = await collect(options);
  options.signal?.throwIfAborted();
  const sessionId = collected.sessionId;
  if (sessionId === undefined) throw new Error("the source has no session id");
  if (options.session !== undefined && options.session !== sessionId) throw new Error("expected session does not match the source session ID");

  const cwd = resolve(options.cwd ?? collected.cwd ?? process.cwd());
  const root = requireGit(cwd, ["rev-parse", "--show-toplevel"]).trim();
  const groups = new Map<string, StagePatch[]>();
  const excluded: StageReport["excluded"] = [];
  for (const patch of collected.patches) {
    const declared = relative(root, resolve(collected.cwd ?? cwd, patch.path));
    if (declared === "" || declared === ".." || declared.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(declared)) {
      excluded.push({ path: patch.path, reason: "path resolves outside the repository", sourceEventId: patch.sourceEventId });
      continue;
    }
    const group = groups.get(declared) ?? [];
    group.push(patch);
    groups.set(declared, group);
  }

  const warnings = bashWarnings(collected);
  const report: StageReport = {
    schemaVersion: 1, kind: "stage", sessionId, source, ...(selection === undefined ? {} : { selection }), cwd, root, dryRun: options.dryRun === true,
    staged: [], unchanged: [], conflicts: [], excluded,
    unattributedBash: warnings.warnings, unattributedBashCount: warnings.count, limit: LIMIT,
  };
  const indexPath = requireGit(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).trim();
  const lockPath = `${indexPath}.lock`;
  const lock = await open(lockPath, "wx");
  let temporary: string | undefined;
  let published = false;
  try {
    options.signal?.throwIfAborted();
    const head = headId(root);
    if (selection !== undefined && selection.head !== head) throw new Error("manifest HEAD does not match the repository; inspect and rebuild the selection");
    if (selection !== undefined && excluded.length > 0) {
      report.conflicts.push(...excluded.map(issue => ({ ...issue, reason: "selected manifest mutation resolves outside the repository" })));
    }
    const indexBytes = await optionalRead(indexPath);
    const plans: Array<{ path: string; content: string; mode: string; operation: "edit" | "write"; hunks: number }> = [];
    for (const [path, patches] of groups) {
      const sourceEventId = patches[0]!.sourceEventId;
      try {
        const baseline = readHeadFile(root, head, path);
        const index = readIndexFile(root, path);
        if (baseline.content !== undefined && patches.some(p => p.operation === "write")) {
          throw new Error("a whole-file write to a tracked file has no ownership pre-image; use exact edits");
        }
        const states: Array<string | undefined> = [baseline.content];
        let content = baseline.content;
        let hunks = 0;
        for (const patch of patches) {
          const plan = planPath(content, [patch]);
          if (plan.status === "conflict") throw new Error(plan.reason);
          if (plan.status === "staged") { content = plan.content; hunks += plan.hunks; }
          states.push(content);
        }
        if (content?.includes("\u0000")) throw new Error("binary content is not supported");
        if (!states.includes(index.content) || index.mode !== baseline.mode) {
          throw new Error("index contains changes outside this session's exact replay states");
        }
        if (content === index.content) { report.unchanged.push(path); continue; }
        if (content === undefined) throw new Error("session produced no file content");
        plans.push({ path, content, mode: baseline.mode, operation: patches.some(p => p.operation === "write") ? "write" : "edit", hunks });
      } catch (error) {
        report.conflicts.push({ path, reason: error instanceof Error ? error.message : String(error), sourceEventId });
      }
    }
    const stagedPaths = requireGit(root, ["diff", "--cached", "--name-only", "--no-renames", "-z"]).split("\u0000").filter(Boolean);
    for (const path of stagedPaths) {
      if (!groups.has(path)) report.conflicts.push({ path, reason: "unrelated changes are already staged; inspect the index before committing", sourceEventId: "index" });
    }
    const intentPaths = requireGit(root, ["diff", "--cached", "--ita-visible-in-index", "--name-only", "--no-renames", "-z"]).split("\u0000").filter(Boolean);
    for (const path of intentPaths) {
      if (!stagedPaths.includes(path)) report.conflicts.push({ path, reason: "intent-to-add index entry is not a completed staged replay", sourceEventId: "index" });
    }
    if (report.conflicts.length > 0) return report;
    if (options.dryRun !== true && plans.length > 0) {
      temporary = await mkdtemp(join(tmpdir(), "dvdst-index-"));
      const privateIndex = join(temporary, "index");
      if (indexBytes !== undefined) await writeFile(privateIndex, indexBytes);
      else requireGit(root, ["read-tree", "--empty"], privateIndex);
      for (const plan of plans) writeIndexFile(root, plan.path, plan.content, plan.mode, privateIndex);
      options.signal?.throwIfAborted();
      if (headId(root) !== head) throw new Error("HEAD changed while staging; retry after inspecting the repository");
      await lock.writeFile(await readFile(privateIndex));
      options.signal?.throwIfAborted();
      await lock.sync();
      await lock.close();
      options.signal?.throwIfAborted();
      await rename(lockPath, indexPath);
      published = true;
    }
    report.staged = plans.map(({ path, operation, hunks }) => ({ path, operation, hunks }));
    return report;
  } finally {
    await lock.close();
    if (!published) await rm(lockPath, { force: true });
    if (temporary !== undefined) await rm(temporary, { recursive: true, force: true });
  }
}

export { LiveEventError };
