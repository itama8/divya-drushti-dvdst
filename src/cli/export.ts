#!/usr/bin/env node
import { guardStdout } from "./stdout.js";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { evidenceToCsv, evidenceToMarkdown, parseEvidenceJsonl } from "../export/render.js";
import { readLiveSnapshot } from "../store/read-live.js";

guardStdout();

function usage(status = 2): never {
  console.error("Usage: dvdst export [--input <evidence.jsonl>] --format markdown|csv");
  console.error("       dvdst export --store <directory> --source <source> --session <id> [--snapshot <sha256>] --format markdown|csv");
  console.error("Reads evidence JSONL or a stored live snapshot and writes one human-readable export to stdout.");
  process.exit(status);
}

async function main(): Promise<void> {
  const args = process.argv[2] === "export" ? process.argv.slice(3) : process.argv.slice(2);
  const { values } = parseArgs({
    args,
    options: {
      input: { type: "string", short: "i" },
      store: { type: "string", short: "s" },
      source: { type: "string" },
      session: { type: "string" },
      snapshot: { type: "string" },
      format: { type: "string", short: "f" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) usage(0);
  if (values.format !== "markdown" && values.format !== "csv") usage();

  const useStore = values.store !== undefined || values.source !== undefined || values.session !== undefined || values.snapshot !== undefined;
  if (useStore && values.input !== undefined) usage();
  if (useStore && (!values.store || !values.source || !values.session)) usage();
  const records = useStore
    ? (await readLiveSnapshot({ store: values.store!, source: values.source!, sessionId: values.session!, ...(values.snapshot === undefined ? {} : { sourceHash: values.snapshot }) })).records
    : parseEvidenceJsonl(values.input ? await readFile(values.input, "utf8") : await readAll(process.stdin));
  process.stdout.write(values.format === "markdown" ? evidenceToMarkdown(records) : evidenceToCsv(records));
}

function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => { text += chunk; });
    stream.on("end", () => resolve(text));
    stream.on("error", reject);
  });
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
