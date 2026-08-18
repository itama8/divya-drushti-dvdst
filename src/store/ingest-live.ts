import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { LiveDecomposer, parseLiveEvent } from "../live/decompose.js";
import { exists, sourceSegment, writeAtomic } from "./fs-util.js";

export interface LiveIngestResult {
  schemaVersion: 1;
  kind: "live-ingestion";
  status: "ingested" | "unchanged";
  store: string;
  source: string;
  sessionId: string;
  sourceHash: string;
  events: number;
  snapshot: string;
}

export async function ingestLiveEvidence(input: string, inputPath: string | undefined, store: string): Promise<LiveIngestResult> {
  const events = [];
  const decomposer = new LiveDecomposer();
  for (const [index, line] of input.split(/\r?\n/).entries()) {
    const event = parseLiveEvent(line, index + 1);
    if (event) events.push({ event, record: decomposer.ingest(event, index + 1) });
  }
  if (events.length === 0) throw new Error("Live input contains no events");

  const first = events[0]!.event;
  if (events.some(({ event }) => event.source !== first.source || event.sessionId !== first.sessionId)) {
    throw new Error("Live ingestion accepts exactly one source and session per input");
  }

  const sourceHash = createHash("sha256").update(input).digest("hex");
  const resolvedStore = resolve(store);
  const sessionDirectory = join(resolvedStore, "sessions", "live", sourceSegment(first.source), sourceSegment(first.sessionId));
  const snapshotsDirectory = join(sessionDirectory, "snapshots");
  const snapshot = join(snapshotsDirectory, sourceHash);
  const result = {
    schemaVersion: 1 as const,
    kind: "live-ingestion" as const,
    store: resolvedStore,
    source: first.source,
    sessionId: first.sessionId,
    sourceHash,
    events: events.length,
    snapshot,
  };

  if (await exists(snapshot)) return { ...result, status: "unchanged" };

  await mkdir(snapshotsDirectory, { recursive: true, mode: 0o700 });
  const temporary = join(snapshotsDirectory, `.${sourceHash}.${process.pid}.${Date.now()}.tmp`);
  await mkdir(join(temporary, "source"), { recursive: true, mode: 0o700 });
  await mkdir(join(temporary, "records"), { recursive: true, mode: 0o700 });
  const timeline = events.map(({ record }) => JSON.stringify(record)).join("\n") + "\n";
  const manifest = {
    schemaVersion: 1,
    adapter: { name: "live", version: 1 },
    status: "complete",
    source: {
      ...(inputPath === undefined ? {} : { path: resolve(inputPath) }),
      filename: inputPath === undefined ? undefined : basename(inputPath),
      sha256: sourceHash,
      bytes: Buffer.byteLength(input),
      eventCount: events.length,
      source: first.source,
      sessionId: first.sessionId,
    },
    records: { timeline: events.length },
  };
  await Promise.all([
    writeFile(join(temporary, "source", "events.jsonl"), input, { mode: 0o600 }),
    writeFile(join(temporary, "records", "timeline.jsonl"), timeline, { mode: 0o600 }),
    writeFile(join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 }),
  ]);
  await rename(temporary, snapshot);
  await writeAtomic(join(sessionDirectory, "latest.json"), `${JSON.stringify({ schemaVersion: 1, sourceHash, snapshot, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  if (!(await exists(join(resolvedStore, "store.json")))) {
    await writeAtomic(join(resolvedStore, "store.json"), `${JSON.stringify({ schemaVersion: 1, name: "dvdst evidence store" }, null, 2)}\n`);
  }
  return { ...result, status: "ingested" };
}
