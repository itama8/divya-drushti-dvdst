#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { devlogFromSummary } from "../devlog/format-devlog.js";
import { buildHandoffSummary } from "../handoff/summary.js";
import { buildProbeBundle } from "../probe/build-bundle.js";

function usage(): never {
  console.error("Usage: dvdst handoff --session <session.jsonl> [--devlog <devlog.md>] [--out <devlog.md>] [--project omakase-v2] [--phase docs-spine] [--checkpoint name] [--focus one-line] [--date YYYY-MM-DD] [--session-num 2]");
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    session: { type: "string", short: "s" },
    devlog: { type: "string", short: "d" },
    out: { type: "string", short: "o" },
    project: { type: "string", default: "omakase-v2" },
    phase: { type: "string", default: "docs-spine" },
    checkpoint: { type: "string", default: "auto-derived" },
    focus: { type: "string", default: "Auto-derived handoff bundle" },
    date: { type: "string", default: new Date().toISOString().slice(0, 10) },
    "session-num": { type: "string", default: "1" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});

if (values.help || !values.session) usage();

try {
  const bundle = await buildProbeBundle({
    sessionPath: values.session,
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
