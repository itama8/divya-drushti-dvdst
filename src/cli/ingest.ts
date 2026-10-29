#!/usr/bin/env node
import { guardStdout } from "./stdout.js";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { isObject } from "../pi/read-jsonl.js";
import { ingestLiveEvidence } from "../store/ingest-live.js";
import { ingestSessionFile } from "../store/ingest-session.js";

guardStdout();

const DEFAULT_STORE = ".dvdst/store";

function usage(status = 2): never {
  console.error("Usage: dvdst ingest <session.jsonl...> [--store <directory>]");
  console.error("       dvdst ingest --live <events.jsonl> [--store <directory>]");
  console.error("       dvdst ingest [--store <directory>]  reads session paths from stdin");
  console.error("Preserves Pi, Claude Code, and Codex session files or one live event stream in the local evidence store.");
  process.exit(status);
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

async function readPathsFromStdin(): Promise<string[]> {
  const text = await readAll(process.stdin);
  const paths: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // Skip the header row that `dvdst sessions --format tsv` writes.
    if (trimmed.startsWith("path\t")) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (isObject(value) && typeof value.path === "string") {
        paths.push(value.path);
        continue;
      }
    } catch {
      // Not a descriptor line. Treat the line as a path.
    }
    // Accept TSV rows from `dvdst sessions --format tsv`: the path is the first field.
    paths.push(trimmed.includes("\t") ? trimmed.split(/\t/)[0]! : trimmed);
  }
  return paths;
}

async function main(): Promise<void> {
  // The dispatcher calls this script with: node --import tsx ingest.ts ingest [...options]
  const args = process.argv[2] === "ingest" ? process.argv.slice(3) : process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args,
    options: {
      live: { type: "string" },
      store: { type: "string", short: "s" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
  if (values.help) usage(0);
  const store = values.store ?? DEFAULT_STORE;

  if (values.live !== undefined) {
    if (positionals.length > 0) usage();
    const input = await readFile(values.live, "utf8");
    const result = await ingestLiveEvidence(input, values.live, store);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (positionals.length === 0 && process.stdin.isTTY) usage();
  const paths = positionals.length > 0 ? positionals : await readPathsFromStdin();
  if (paths.length === 0) usage();

  let failures = 0;
  for (const source of paths) {
    try {
      const result = await ingestSessionFile(source, store);
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
      failures += 1;
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures > 0) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
