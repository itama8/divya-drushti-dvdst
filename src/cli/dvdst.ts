#!/usr/bin/env node
import { guardStdout } from "./stdout.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

guardStdout();

const commands: Record<string, { script: string; summary: string }> = {
  overview: { script: "analysis.ts", summary: "one row per session: time, tokens, cost, tool totals" },
  turns: { script: "analysis.ts", summary: "one row per model request: model, tokens, cost, timing" },
  calls: { script: "analysis.ts", summary: "one row per tool call joined to its result" },
  context: { script: "analysis.ts", summary: "one row per system prompt section, with its size" },
  rows: { script: "analysis.ts", summary: "run a project extractor: rows <name|file> [session...]" },
  schema: { script: "analysis.ts", summary: "fields of the row streams and project extractors" },
  cache: { script: "analysis.ts", summary: "show or empty the row cache: cache [--clear]" },
  sessions: { script: "sessions.ts", summary: "list Pi session files under a directory" },
  files: { script: "records.ts", summary: "files a session read and mutated" },
  commands: { script: "records.ts", summary: "shell commands of a session, by class" },
  skills: { script: "records.ts", summary: "skill invocations, spans, and attributions" },
  trace: { script: "trace.ts", summary: "provenance of one record" },
  handoff: { script: "handoff.ts", summary: "compact closeout summary of a session" },
  "handoff-devlog": { script: "handoff-devlog.ts", summary: "draft a devlog from a handoff summary" },
  probe: { script: "probe.ts", summary: "full evidence bundle of a session" },
  stage: { script: "stage.ts", summary: "stage one session's edits into the git index" },
  live: { script: "live.ts", summary: "convert a live event stream to observed evidence" },
  ingest: { script: "ingest.ts", summary: "snapshot session files into the evidence store" },
  normalize: { script: "normalize.ts", summary: "write normalized records into a store snapshot" },
  artifacts: { script: "artifacts.ts", summary: "write file, command, and test artifacts into a snapshot" },
  events: { script: "events.ts", summary: "write deterministic events and findings into a snapshot" },
  timeline: { script: "timeline.ts", summary: "read the timeline of a stored live stream" },
  export: { script: "export.ts", summary: "render stored evidence as markdown or CSV" },
  cleanup: { script: "cleanup.ts", summary: "remove a local evidence store" },
};

function usage(status: number): never {
  console.error("Usage: dvdst <command> [args]    (dvdst <command> --help for its options)");
  console.error("");
  for (const [name, command] of Object.entries(commands)) console.error(`  ${name.padEnd(15)} ${command.summary}`);
  console.error("");
  console.error('Session commands take a file, a session id or id prefix, or "latest".');
  console.error("A file in .dvdst/extractors/ adds a command of its name; see docs/extractors.md.");
  console.error("Start with: dvdst overview latest    dvdst schema calls");
  process.exit(status);
}

const arg = process.argv[2];
if (!arg || arg === "--help" || arg === "-h" || arg === "help") usage(arg ? 0 : 2);
// A name that is not a command may be a project extractor; analysis.ts looks it up.
const command = commands[arg] ?? (/^[A-Za-z0-9][\w.-]*$/.test(arg) ? { script: "analysis.ts", summary: "" } : undefined);
if (command === undefined) {
  console.error(`Unknown command ${JSON.stringify(arg)}.`);
  usage(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, command.script);
// Forward the subcommand name as argv[0] of the sub-script so parseArgs sees it consistently.
const rest = process.argv.slice(3);
// Resolve tsx from this package, so the CLI also runs from another working directory.
const result = spawnSync(process.execPath, [`--import`, import.meta.resolve("tsx"), target, arg, ...rest], { stdio: "inherit" });
process.exit(result.status ?? 1);
