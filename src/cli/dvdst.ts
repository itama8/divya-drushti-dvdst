#!/usr/bin/env node
import { COMMANDS as commands } from "./commands.js";
import { guardStdout } from "./stdout.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

guardStdout();

// Shared registry also powers machine-readable command discovery.

function usage(status: number): never {
  console.error("Usage: dvdst <command> [args]    (dvdst <command> --help for its options)");
  console.error("");
  for (const [name, command] of Object.entries(commands)) console.error(`  ${name.padEnd(15)} ${command.summary}`);
  console.error("");
  console.error('Session commands take a file, a session id or id prefix, or "latest".');
  console.error("A file in .dvdst/extractors/ adds a command of its name; see docs/extractors.md.");
  console.error("Start with: dvdst capabilities    dvdst overview latest    dvdst schema calls");
  process.exit(status);
}

const arg = process.argv[2];
if (!arg || arg === "--help" || arg === "-h" || arg === "help") usage(arg ? 0 : 2);
// A name that is not a command may be a project extractor; analysis.ts looks it up.
const command = Object.hasOwn(commands, arg) ? commands[arg] : (/^[A-Za-z0-9][\w.-]*$/.test(arg) ? { script: "analysis.ts", summary: "" } : undefined);
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
