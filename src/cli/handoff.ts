#!/usr/bin/env node
import { parseArgs } from "node:util";
import { buildHandoffSummary, handoffToText } from "../handoff/summary.js";
import { buildProbeBundle } from "../probe/build-bundle.js";

function usage(): never {
  console.error("Usage: dvdst handoff --session <session.jsonl> [--devlog <devlog.md>] [--format text|json]");
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    session: { type: "string", short: "s" },
    devlog: { type: "string", short: "d" },
    format: { type: "string", default: "text" },
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
  if (values.format === "json") {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(handoffToText(summary));
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
