#!/usr/bin/env node
import { join } from "node:path";
import { parseArgs } from "node:util";
import { extractArtifacts } from "../artifacts/extract.js";
import { extractEvents } from "../events/extract.js";
import { normalizeSnapshot } from "../normalize/normalize.js";
import { guardStdout } from "./stdout.js";
import { exists } from "../store/fs-util.js";
import { ingestSessionFile } from "../store/ingest-session.js";
import { readSessionSnapshot } from "../store/read-session.js";

guardStdout();

const DEFAULT_STORE = ".dvdst/store";

function usage(status = 2): never {
  console.error("Usage: dvdst events <session.jsonl> [--store <directory>]");
  console.error("       dvdst events --store <directory> --session <id> [--snapshot <sha256>]");
  console.error("Ingests, normalizes, and extracts artifacts if needed, then writes deterministic events and findings into the snapshot.");
  process.exit(status);
}

/**
 * Runs normalize and artifact extraction on a snapshot only when their derived
 * outputs are missing, so repeat invocations stay cheap and deterministic.
 */
async function ensurePipeline(snapshot: string, store: string, sessionId: string, sourceHash: string): Promise<void> {
  if (!(await exists(join(snapshot, "records", "entries.jsonl")))) {
    await normalizeSnapshot({ store, sessionId, sourceHash });
  }
  if (!(await exists(join(snapshot, "artifacts", "commands.jsonl")))) {
    await extractArtifacts({ store, sessionId, sourceHash });
  }
}

async function main(): Promise<void> {
  // The dispatcher calls this script with: node --import tsx events.ts events [...options]
  const args = process.argv[2] === "events" ? process.argv.slice(3) : process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args,
    options: {
      store: { type: "string", short: "s" },
      session: { type: "string" },
      snapshot: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
  if (values.help) usage(0);
  const store = values.store ?? DEFAULT_STORE;

  if (values.session !== undefined) {
    if (positionals.length > 0) usage();
    const sourceHash = values.snapshot === undefined ? undefined : values.snapshot;
    const snapshotInfo = await readSessionSnapshot({ store, sessionId: values.session, ...(sourceHash === undefined ? {} : { sourceHash }) });
    await ensurePipeline(snapshotInfo.path, store, values.session, snapshotInfo.sourceHash);
    const result = await extractEvents({ store, sessionId: values.session, sourceHash: snapshotInfo.sourceHash });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (positionals.length === 0 || values.snapshot !== undefined) usage();
  const source = positionals[0]!;
  const ingested = await ingestSessionFile(source, store);
  const snapshotInfo = await readSessionSnapshot({ store, sessionId: ingested.sessionId });
  await ensurePipeline(snapshotInfo.path, store, ingested.sessionId, snapshotInfo.sourceHash);
  const result = await extractEvents({ store, sessionId: ingested.sessionId, sourceHash: snapshotInfo.sourceHash });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
