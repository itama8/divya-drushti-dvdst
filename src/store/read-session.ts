import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isObject } from "../pi/read-jsonl.js";
import { sourceSegment } from "./fs-util.js";

const SHA256_RE = /^[a-f0-9]{64}$/;

export interface SessionSnapshot {
  store: string;
  sessionId: string;
  sourceHash: string;
  path: string;
  rawPath: string;
  manifest: Record<string, unknown>;
}

export async function readSessionSnapshot(options: {
  store: string;
  sessionId: string;
  sourceHash?: string;
}): Promise<SessionSnapshot> {
  const store = resolve(options.store);
  const sessionDirectory = join(store, "sessions", "pi", sourceSegment(options.sessionId));
  let sourceHash = options.sourceHash;
  if (sourceHash === undefined) {
    let latest: unknown;
    try {
      latest = JSON.parse(await readFile(join(sessionDirectory, "latest.json"), "utf8"));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot read latest session snapshot for ${options.sessionId}: ${reason}`);
    }
    if (!isObject(latest) || typeof latest.sourceHash !== "string") {
      throw new Error(`Latest session snapshot for ${options.sessionId} has no sourceHash`);
    }
    sourceHash = latest.sourceHash;
  }
  if (sourceHash === undefined || !SHA256_RE.test(sourceHash)) throw new Error("sourceHash must be a SHA-256 hex digest");
  const path = join(sessionDirectory, "snapshots", sourceHash);
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read session manifest snapshot ${sourceHash}: ${reason}`);
  }
  if (!isObject(manifest)) throw new Error(`Session manifest snapshot ${sourceHash} is not an object`);
  return { store, sessionId: options.sessionId, sourceHash, path, rawPath: join(path, "source", "raw.jsonl"), manifest };
}
