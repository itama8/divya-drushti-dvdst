#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readLiveSnapshot } from "../store/read-live.js";

function usage(status = 2): never {
  console.error("Usage: dvdst timeline --store <directory> --source <source> --session <id> [--snapshot <sha256>] [--kind <event-kind>]");
  console.error("Writes canonical timeline evidence as JSONL.");
  process.exit(status);
}

async function main(): Promise<void> {
  const args = process.argv[2] === "timeline" ? process.argv.slice(3) : process.argv.slice(2);
  const { values } = parseArgs({
    args,
    options: {
      store: { type: "string", short: "s" },
      source: { type: "string" },
      session: { type: "string" },
      snapshot: { type: "string" },
      kind: { type: "string", short: "k" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) usage(0);
  if (!values.store || !values.source || !values.session) usage();
  const snapshot = await readLiveSnapshot({
    store: values.store,
    source: values.source,
    sessionId: values.session,
    ...(values.snapshot === undefined ? {} : { sourceHash: values.snapshot }),
  });
  for (const record of snapshot.records) {
    if (values.kind === undefined || record.kind === values.kind) process.stdout.write(`${JSON.stringify(record)}\n`);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
