#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { ingestLiveEvidence } from "../store/ingest-live.js";

function usage(status = 2): never {
  console.error("Usage: dvdst ingest --live <events.jsonl> --store <directory>");
  console.error("Preserves one live source session and its observed evidence in the local evidence store.");
  process.exit(status);
}

async function main(): Promise<void> {
  const args = process.argv[2] === "ingest" ? process.argv.slice(3) : process.argv.slice(2);
  const { values } = parseArgs({
    args,
    options: {
      live: { type: "string" },
      store: { type: "string", short: "s" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) usage(0);
  if (!values.live || !values.store) usage();
  const input = await readFile(values.live, "utf8");
  const result = await ingestLiveEvidence(input, values.live, values.store);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
