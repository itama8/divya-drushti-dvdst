#!/usr/bin/env node
import { parseArgs } from "node:util";
import { extractArtifacts } from "../artifacts/extract.js";
import { join } from "node:path";
import { normalizeSnapshot } from "../normalize/normalize.js";
import { resolveSession } from "../pi/resolve-sessions.js";
import { exists } from "../store/fs-util.js";
import { ingestSessionFile } from "../store/ingest-session.js";
import { readSessionSnapshot } from "../store/read-session.js";

const DEFAULT_STORE = ".dvdst/store";

function usage(status = 2): never {
  console.error("Usage: dvdst artifacts <session> [--store <directory>] [--config <file>]");
  console.error("       dvdst artifacts --store <directory> --session <id> [--snapshot <sha256>] [--config <file>]");
  console.error("Ingests and normalizes the session if needed, then extracts tool artifacts into the snapshot.");
  process.exit(status);
}

async function main(): Promise<void> {
  // The dispatcher calls this script with: node --import tsx artifacts.ts artifacts [...options]
  const args = process.argv[2] === "artifacts" ? process.argv.slice(3) : process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args,
    options: {
      store: { type: "string", short: "s" },
      session: { type: "string" },
      snapshot: { type: "string" },
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
  if (values.help) usage(0);
  const store = values.store ?? DEFAULT_STORE;
  const config = values.config === undefined ? {} : { configPath: values.config };

  if (values.session !== undefined) {
    if (positionals.length > 0) usage();
    const snapshotInfo = await readSessionSnapshot({ store, sessionId: values.session, ...(values.snapshot === undefined ? {} : { sourceHash: values.snapshot }) });
    if (!(await exists(join(snapshotInfo.path, "records", "entries.jsonl")))) {
      await normalizeSnapshot({ store, sessionId: values.session, sourceHash: snapshotInfo.sourceHash });
    }
    const result = await extractArtifacts({ store, sessionId: values.session, sourceHash: snapshotInfo.sourceHash, ...config });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (positionals.length === 0 || values.snapshot !== undefined) usage();
  const source = await resolveSession(positionals[0]);
  const ingested = await ingestSessionFile(source, store);
  const snapshotInfo = await readSessionSnapshot({ store, sessionId: ingested.sessionId });
  if (!(await exists(join(snapshotInfo.path, "records", "entries.jsonl")))) {
    await normalizeSnapshot({ store, sessionId: ingested.sessionId, sourceHash: snapshotInfo.sourceHash });
  }
  const result = await extractArtifacts({ store, sessionId: ingested.sessionId, sourceHash: snapshotInfo.sourceHash, ...config });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}