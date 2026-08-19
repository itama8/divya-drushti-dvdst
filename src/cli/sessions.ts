#!/usr/bin/env node
import { guardStdout } from "./stdout.js";
import { parseArgs } from "node:util";
import { discoverSessions } from "../pi/sessions.js";

guardStdout();

function usage(): never {
  console.error("Usage: dvdst sessions <path...> [--format json|jsonl|tsv] [--limit N]");
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    format: { type: "string", default: "tsv" },
    limit: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
  allowPositionals: true,
});

if (values.help) usage();

// Support the dispatcher (argv = [node, sessions.ts, sessions, <path...>]) and
// a direct npm script (argv = [node, sessions.ts, <path...>]).
const args = process.argv[2] === "sessions" ? process.argv.slice(3) : process.argv.slice(2);
if (args.length === 0 || args[0]!.startsWith("-")) usage();

const candidates = await discoverSessions(args);
const limited = values.limit ? candidates.slice(0, Number.parseInt(values.limit, 10)) : candidates;
if (values.format === "json") {
  process.stdout.write(`${JSON.stringify(limited, null, 2)}\n`);
} else if (values.format === "jsonl") {
  for (const candidate of limited) process.stdout.write(`${JSON.stringify(candidate)}\n`);
} else {
  process.stdout.write(`path\tproject\tbytes\tmodified\n`);
  for (const candidate of limited) process.stdout.write(`${candidate.path}\t${candidate.project}\t${candidate.bytes}\t${new Date(candidate.modified).toISOString()}\n`);
}
