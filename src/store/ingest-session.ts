import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isObject } from "../pi/read-jsonl.js";
import { exists, sourceSegment, writeAtomic } from "./fs-util.js";

export type SessionManifestStatus = "complete" | "partial";
export type SessionChangeClass = "initial" | "append" | "replacement" | "truncation" | "unchanged";

export interface SessionIngestResult {
  schemaVersion: 1;
  kind: "session-ingestion";
  status: "ingested" | "unchanged";
  store: string;
  source: string;
  sessionId: string;
  sourceHash: string;
  bytes: number;
  lines: number;
  manifestStatus: SessionManifestStatus | "unknown";
  change: { class: SessionChangeClass; previousSnapshot?: string };
  diagnostics: number;
  snapshot: string;
}

export class SessionIngestError extends Error {
  constructor(message: string, readonly source: string) {
    super(`Cannot ingest ${source}: ${message}`);
    this.name = "SessionIngestError";
  }
}

const MAX_DIAGNOSTICS = 20;
const SHA256_RE = /^[a-f0-9]{64}$/;

interface HeaderInfo {
  line: number;
  id: string;
  version?: number;
  cwd?: string;
  timestamp?: string;
}

interface ScanResult {
  hash: string;
  bytes: number;
  lines: number;
  entries: number;
  byType: Record<string, number>;
  diagnostics: { line: number; message: string }[];
  diagnosticsTruncated: boolean;
  header: HeaderInfo;
}

interface PreviousState {
  sourceHash: string;
  bytes: number | undefined;
  complete: boolean | undefined;
  snapshot: string;
  rawPath: string;
}

/**
 * Streams a Pi session file once. Computes the full-content hash, validates
 * every line, counts entry types, and locates the session header. Memory use
 * stays proportional to the diagnostics list, not to the file size.
 */
function scanSource(source: string): Promise<ScanResult> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const byType: Record<string, number> = {};
    const diagnostics: { line: number; message: string }[] = [];
    let diagnosticsTruncated = false;
    let bytes = 0;
    let lines = 0;
    let entries = 0;
    let header: HeaderInfo | undefined;
    let pending = Buffer.alloc(0);

    const addDiagnostic = (line: number, message: string): void => {
      if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push({ line, message });
      else diagnosticsTruncated = true;
    };

    const examine = (text: string, line: number): void => {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (error) {
        addDiagnostic(line, `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (!isObject(value)) {
        addDiagnostic(line, "line must be a JSON object");
        return;
      }
      entries += 1;
      const type = typeof value.type === "string" ? value.type : "unknown";
      byType[type] = (byType[type] ?? 0) + 1;
      if (type !== "session" || header !== undefined) return;
      header = {
        line,
        id: typeof value.id === "string" ? value.id : "",
        ...(typeof value.version === "number" ? { version: value.version } : {}),
        ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
        ...(typeof value.timestamp === "string" ? { timestamp: value.timestamp } : {}),
      };
      if (value.version !== undefined && typeof value.version !== "number") addDiagnostic(line, "session version must be a number");
      if (value.cwd !== undefined && typeof value.cwd !== "string") addDiagnostic(line, "session cwd must be a string");
      if (value.timestamp !== undefined && typeof value.timestamp !== "string") addDiagnostic(line, "session timestamp must be a string");
    };

    (async () => {
      try {
        for await (const rawChunk of createReadStream(source)) {
          const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
          hash.update(chunk);
          bytes += chunk.length;
          const combined = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
          let lineStart = 0;
          for (let index = 0; index < combined.length; index += 1) {
            if (combined[index] !== 0x0a) continue;
            lines += 1;
            const lineBuffer = combined.subarray(lineStart, index);
            const text = (lineBuffer.at(-1) === 0x0d ? lineBuffer.subarray(0, -1) : lineBuffer).toString("utf8");
            if (text.trim().length > 0) examine(text, lines);
            lineStart = index + 1;
          }
          pending = combined.subarray(lineStart);
        }
        if (pending.length > 0) {
          lines += 1;
          const text = (pending.at(-1) === 0x0d ? pending.subarray(0, -1) : pending).toString("utf8");
          if (text.trim().length > 0) examine(text, lines);
        }
      } catch (error) {
        reject(new SessionIngestError(`cannot read session file: ${error instanceof Error ? error.message : String(error)}`, source));
        return;
      }
      if (header === undefined) {
        reject(new SessionIngestError("no valid Pi session header", source));
        return;
      }
      if (header.id.length === 0) {
        reject(new SessionIngestError(`session header on line ${header.line} has no id`, source));
        return;
      }
      resolvePromise({
        hash: hash.digest("hex"),
        bytes,
        lines,
        entries,
        byType,
        diagnostics,
        diagnosticsTruncated,
        header,
      });
    })();
  });
}

/** Copies a file verbatim to a private target file. */
function copyStream(source: string, target: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const input = createReadStream(source);
    const output = createWriteStream(target, { mode: 0o600 });
    input.on("error", reject);
    output.on("error", reject);
    output.on("finish", resolvePromise);
    input.pipe(output);
  });
}

/** Hashes the first `bytes` bytes of a file and compares against an expected digest. */
async function prefixHashMatches(filePath: string, bytes: number, expected: string): Promise<boolean> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(filePath, { start: 0, end: bytes - 1 });
    stream.on("data", (rawChunk: Buffer) => { hash.update(rawChunk); });
    stream.on("error", reject);
    stream.on("end", () => resolvePromise());
  });
  return hash.digest("hex") === expected;
}

async function readPreviousState(sessionDirectory: string): Promise<PreviousState | undefined> {
  let latest: unknown;
  try {
    latest = JSON.parse(await readFile(join(sessionDirectory, "latest.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (!isObject(latest) || typeof latest.sourceHash !== "string" || !SHA256_RE.test(latest.sourceHash)) return undefined;
  const snapshot = join(sessionDirectory, "snapshots", latest.sourceHash);
  const rawPath = join(snapshot, "source", "raw.jsonl");
  let state: unknown;
  try {
    state = JSON.parse(await readFile(join(snapshot, "source", "source-state.json"), "utf8"));
  } catch {
    return { sourceHash: latest.sourceHash, bytes: undefined, complete: undefined, snapshot, rawPath };
  }
  if (!isObject(state) || typeof state.sha256 !== "string" || !SHA256_RE.test(state.sha256) || typeof state.bytes !== "number") {
    return { sourceHash: latest.sourceHash, bytes: undefined, complete: undefined, snapshot, rawPath };
  }
  return {
    sourceHash: latest.sourceHash,
    bytes: state.bytes,
    complete: typeof state.complete === "boolean" ? state.complete : undefined,
    snapshot,
    rawPath,
  };
}

function changeField(changeClass: SessionChangeClass, previous: PreviousState | undefined): { class: SessionChangeClass; previousSnapshot?: string } {
  if (changeClass === "initial" || changeClass === "unchanged" || previous === undefined) return { class: changeClass };
  return { class: changeClass, previousSnapshot: previous.sourceHash };
}

/**
 * Ingests one Pi session file into the evidence store. The raw source is
 * preserved verbatim in a content-addressed snapshot together with a manifest
 * and a source-state summary. A repeated unchanged ingestion performs no
 * writes. Changed files produce a new snapshot whose manifest records whether
 * the change was an append, a replacement, or a truncation.
 */
export async function ingestSessionFile(source: string, store: string): Promise<SessionIngestResult> {
  const resolvedSource = resolve(source);
  const resolvedStore = resolve(store);
  let fileStat;
  try {
    fileStat = await stat(resolvedSource);
  } catch (error) {
    throw new SessionIngestError(`cannot stat session file: ${error instanceof Error ? error.message : String(error)}`, resolvedSource);
  }
  const summary = await scanSource(resolvedSource);
  const sessionId = summary.header.id;
  const sessionDirectory = join(resolvedStore, "sessions", "pi", sourceSegment(sessionId));
  const snapshot = join(sessionDirectory, "snapshots", summary.hash);
  const previous = await readPreviousState(sessionDirectory);
  const manifestStatus: SessionManifestStatus = summary.diagnostics.length === 0 ? "complete" : "partial";

  const base = {
    schemaVersion: 1 as const,
    kind: "session-ingestion" as const,
    store: resolvedStore,
    source: resolvedSource,
    sessionId,
    sourceHash: summary.hash,
    bytes: summary.bytes,
    lines: summary.lines,
    manifestStatus: manifestStatus as SessionManifestStatus | "unknown",
    diagnostics: summary.diagnostics.length,
    snapshot,
  };

  if (await exists(snapshot)) {
    return {
      ...base,
      status: "unchanged" as const,
      manifestStatus: previous?.complete === false ? "partial" : previous?.complete === true ? "complete" : "unknown",
      change: { class: "unchanged" as const },
    };
  }

  let changeClass: Exclude<SessionChangeClass, "unchanged">;
  if (previous === undefined) {
    changeClass = "initial";
  } else if (previous.bytes === undefined) {
    changeClass = "replacement";
  } else if (summary.bytes >= previous.bytes && await prefixHashMatches(resolvedSource, previous.bytes, previous.sourceHash)) {
    changeClass = "append";
  } else if (summary.bytes < previous.bytes && await prefixHashMatches(previous.rawPath, summary.bytes, summary.hash)) {
    changeClass = "truncation";
  } else {
    changeClass = "replacement";
  }

  const snapshotsDirectory = dirname(snapshot);
  await mkdir(snapshotsDirectory, { recursive: true, mode: 0o700 });
  const temporary = join(snapshotsDirectory, `.${summary.hash}.${process.pid}.${Date.now()}.tmp`);
  try {
    await mkdir(join(temporary, "source"), { recursive: true, mode: 0o700 });
    await copyStream(resolvedSource, join(temporary, "source", "raw.jsonl"));
    const manifest = {
      schemaVersion: 1,
      adapter: { name: "pi", version: 1 },
      status: manifestStatus,
      source: {
        path: resolvedSource,
        filename: basename(resolvedSource),
        sha256: summary.hash,
        bytes: summary.bytes,
        lines: summary.lines,
        mtimeMs: fileStat.mtimeMs,
        sessionId,
        ...(summary.header.version === undefined ? {} : { version: summary.header.version }),
        ...(summary.header.cwd === undefined ? {} : { cwd: summary.header.cwd }),
        ...(summary.header.timestamp === undefined ? {} : { timestamp: summary.header.timestamp }),
      },
      change: changeField(changeClass, previous),
      counts: {
        entries: summary.entries,
        byType: summary.byType,
        diagnostics: summary.diagnostics.length,
        ...(summary.diagnosticsTruncated ? { diagnosticsTruncated: true } : {}),
      },
      diagnostics: summary.diagnostics,
      ingestedAt: new Date().toISOString(),
    };
    const sourceState = {
      schemaVersion: 1,
      sha256: summary.hash,
      bytes: summary.bytes,
      lines: summary.lines,
      complete: manifestStatus === "complete",
    };
    await Promise.all([
      writeFile(join(temporary, "source", "source-state.json"), `${JSON.stringify(sourceState, null, 2)}\n`, { mode: 0o600 }),
      writeFile(join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 }),
    ]);
    await rename(temporary, snapshot);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (error instanceof SessionIngestError) throw error;
    throw new SessionIngestError(`cannot write snapshot: ${error instanceof Error ? error.message : String(error)}`, resolvedSource);
  }

  await writeAtomic(join(sessionDirectory, "latest.json"), `${JSON.stringify({ schemaVersion: 1, sourceHash: summary.hash, snapshot, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  if (!(await exists(join(resolvedStore, "store.json")))) {
    await writeAtomic(join(resolvedStore, "store.json"), `${JSON.stringify({ schemaVersion: 1, name: "dvdst evidence store" }, null, 2)}\n`);
  }
  return { ...base, status: "ingested", change: changeField(changeClass, previous) };
}
