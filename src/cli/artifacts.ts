#!/usr/bin/env node
import { parseArgs } from "node:util";
import { extractArtifacts } from "../artifacts/extract.js";
import { ingestSessionFile } from "../store/ingest-session.js";

const DEFAULT_STORE = ".dvdst/store";

function usage(status = 2): never {
  console.error("Usage: dvdst artifacts <session.jsonl> [--store <directory>]");
  console.error("       dvdst artifacts --store <directory> --session <id> [--snapshot <sha256>]");
  console.error("Ingests the session file if needed, then extracts tool artifacts into the snapshot.");
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
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
  if (values.help) usage(0);
  const store = values.store ?? DEFAULT_STORE;

  if (values.session !== undefined) {
    if (positionals.length > 0) usage();
    const result = await extractArtifacts({
      store,
      sessionId: values.session,
      ...(values.snapshot === undefined ? {} : { sourceHash: values.snapshot }),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (positionals.length === 0 || values.snapshot !== undefined) usage();
  const source = positionals[0]!;
  const ingested = await ingestSessionFile(source, store);
  const result = await extractArtifacts({ store, sessionId: ingested.sessionId });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}