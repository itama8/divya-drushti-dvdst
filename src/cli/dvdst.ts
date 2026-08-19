#!/usr/bin/env node
import { guardStdout } from "./stdout.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

guardStdout();

const commands: Record<string, string> = {
  probe: "probe.ts",
  live: "live.ts",
  export: "export.ts",
  ingest: "ingest.ts",
  normalize: "normalize.ts",
  artifacts: "artifacts.ts",
  events: "events.ts",
  timeline: "timeline.ts",
  handoff: "handoff.ts",
  "handoff-devlog": "handoff-devlog.ts",
  sessions: "sessions.ts",
  files: "records.ts",
  commands: "records.ts",
  skills: "records.ts",
  trace: "trace.ts",
  cleanup: "cleanup.ts",
};

const arg = process.argv[2];
if (!arg || arg === "--help" || arg === "-h" || !Object.keys(commands).includes(arg)) {
  console.error(`Usage: dvdst <${Object.keys(commands).join("|")}> [args]`);
  process.exit(arg ? 0 : 2);
}

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, commands[arg]!);
// Forward the subcommand name as argv[0] of the sub-script so parseArgs sees it consistently.
const rest = process.argv.slice(3);
const result = spawnSync(process.execPath, [`--import`, `tsx`, target, arg, ...rest], { stdio: "inherit" });
process.exit(result.status ?? 1);
