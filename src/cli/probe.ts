#!/usr/bin/env node
import { guardStdout } from "./stdout.js";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { handoffToText } from "../handoff/summary.js";
import { buildProbeBundle } from "../probe/build-bundle.js";

guardStdout();

function usage(): never {
  console.error("Usage: dvdst probe --session <session.jsonl> [--devlog <devlog.md>] [--out <dir>] [--pretty]");
  process.exit(2);
}

const stripped = process.argv[2] === "probe" ? process.argv.slice(3) : process.argv.slice(2);
const { values } = parseArgs({
  args: stripped,
  options: {
    session: { type: "string", short: "s" },
    devlog: { type: "string", short: "d" },
    out: { type: "string", short: "o" },
    pretty: { type: "boolean", default: false },
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

  if (values.out) {
    const directory = values.out;
    await writeFile(`${directory}/bundle.json`, JSON.stringify(bundle, null, values.pretty ? 2 : undefined));
    await writeFile(`${directory}/skills.jsonl`, (bundle.skills.invocations as unknown[]).map((row) => JSON.stringify(row)).join("\n") + "\n");
    await writeFile(`${directory}/attributions.jsonl`, (bundle.skills.attributedRecords as unknown[]).map((row) => JSON.stringify(row)).join("\n") + "\n");
    await writeFile(`${directory}/commands.jsonl`, (bundle.commands as unknown[]).map((row) => JSON.stringify(row)).join("\n") + "\n");
    await writeFile(`${directory}/files.jsonl`, (bundle.files as unknown[]).map((row) => JSON.stringify(row)).join("\n") + "\n");
  } else {
    process.stdout.write(`${JSON.stringify(bundle, null, values.pretty ? 2 : undefined)}\n`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
