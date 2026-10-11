#!/usr/bin/env node
import { guardStdout } from "./stdout.js";
import { parseArgs } from "node:util";
import { buildHandoffSummary, handoffToText } from "../handoff/summary.js";
import { resolveSession } from "../pi/resolve-sessions.js";
import { buildProbeBundle } from "../probe/build-bundle.js";

guardStdout();

function usage(): never {
  console.error("Usage: dvdst handoff <session> [--devlog <devlog.md>] [--format text|json]");
  console.error('A session is a file, a session id or id prefix, or "latest". --session <session> is also accepted.');
  process.exit(2);
}

const stripped = process.argv[2] === "handoff" ? process.argv.slice(3) : process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: stripped,
  options: {
    session: { type: "string", short: "s" },
    devlog: { type: "string", short: "d" },
    format: { type: "string", default: "text" },
    help: { type: "boolean", short: "h" },
  },
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
