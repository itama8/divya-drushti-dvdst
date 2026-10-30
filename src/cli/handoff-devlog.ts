#!/usr/bin/env node
import { CLI_OPTIONS, parserOptions } from "./command-options.js";
import { guardStdout } from "./stdout.js";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { devlogFromSummary } from "../devlog/format-devlog.js";
import { buildHandoffSummary } from "../handoff/summary.js";
import { resolveSession } from "../pi/resolve-sessions.js";
import { buildProbeBundle } from "../probe/build-bundle.js";

guardStdout();

function usage(): never {
  console.error("Usage: dvdst handoff-devlog <session> [--devlog <devlog.md>] [--out <devlog.md>] [--project omakase-v2] [--phase docs-spine] [--checkpoint name] [--focus one-line] [--date YYYY-MM-DD] [--session-num 2]");
  process.exit(2);
}

const stripped = process.argv[2] === "handoff-devlog" ? process.argv.slice(3) : process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: stripped,
  options: parserOptions(CLI_OPTIONS.handoffDevlog),
  strict: true,
  allowPositionals: true,
});

if (values.help || positionals.length > 1 || (values.session !== undefined && positionals.length > 0)) usage();

try {
  const bundle = await buildProbeBundle({
    sessionPath: await resolveSession(values.session ?? positionals[0]),
    ...(values.devlog ? { devlogPath: values.devlog } : {}),
  });
  const summary = buildHandoffSummary(bundle);
  const devlog = devlogFromSummary(summary, {
    date: values.date,
    session: Number.parseInt(values["session-num"] ?? "1", 10),
    project: values.project,
    phase: values.phase,
    checkpoint: values.checkpoint,
    focus: values.focus,
  });
  if (values.out) {
    await writeFile(values.out, devlog);
  } else {
    process.stdout.write(devlog);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
