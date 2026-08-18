import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseEvidenceJsonl, type EvidenceRecord } from "../export/render.js";

function sourceSegment(value: string): string {
  return encodeURIComponent(value);
}

export interface LiveSnapshot {
  store: string;
  source: string;
  sessionId: string;
  sourceHash: string;
  path: string;
  records: EvidenceRecord[];
}

export async function readLiveSnapshot(options: {
  store: string;
  source: string;
  sessionId: string;
  sourceHash?: string;
}): Promise<LiveSnapshot> {
  const store = resolve(options.store);
  const sessionDirectory = join(store, "sessions", "live", sourceSegment(options.source), sourceSegment(options.sessionId));
  let sourceHash = options.sourceHash;
  if (sourceHash === undefined) {
    let latest: unknown;
    try {
      latest = JSON.parse(await readFile(join(sessionDirectory, "latest.json"), "utf8"));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot read latest live snapshot for ${options.source}/${options.sessionId}: ${reason}`);
    }
    if (typeof latest !== "object" || latest === null || Array.isArray(latest) || typeof (latest as Record<string, unknown>).sourceHash !== "string") {
      throw new Error(`Latest live snapshot for ${options.source}/${options.sessionId} has no sourceHash`);
    }
    sourceHash = (latest as Record<string, string>).sourceHash;
  }
  if (sourceHash === undefined || !/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error("sourceHash must be a SHA-256 hex digest");
  const selectedHash = sourceHash;
  const path = join(sessionDirectory, "snapshots", selectedHash);
  let timeline: string;
  try {
    timeline = await readFile(join(path, "records", "timeline.jsonl"), "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read live timeline snapshot ${selectedHash}: ${reason}`);
  }
  return { store, source: options.source, sessionId: options.sessionId, sourceHash: selectedHash, path, records: parseEvidenceJsonl(timeline) };
}
