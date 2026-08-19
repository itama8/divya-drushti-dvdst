#!/usr/bin/env node
import { guardStdout } from "./stdout.js";
import { parseArgs } from "node:util";
import { normalizeSnapshot } from "../normalize/normalize.js";
import { ingestSessionFile } from "../store/ingest-session.js";

guardStdout();

const DEFAULT_STORE = ".dvdst/store";

function usage(status = 2): never {
  console.error("Usage: dvdst normalize <session.jsonl> [--store <directory>]");
  console.error("       dvdst normalize --store <directory> --session <id> [--snapshot <sha256>]");
  console.error("Ingests the session file if needed, then writes normalized records into the snapshot.");
  process.exit(status);
}

async function main(): Promise<void> {
  // The dispatcher calls this script with: node --import tsx normalize.ts normalize [...options]
  const args = process.argv[2] === "normalize" ? process.argv.slice(3) : process.argv.slice(2);
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
    const result = await normalizeSnapshot({
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
  const result = await normalizeSnapshot({ store, sessionId: ingested.sessionId });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}