#!/usr/bin/env node
import { parseArgs } from "node:util";
import { guardStdout } from "./stdout.js";
import { LiveEventError, stageChanges } from "../stage/stage.js";

guardStdout();
const cancellation = new AbortController();
const cancel = () => cancellation.abort(new Error("staging interrupted"));
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);

function usage(status = 2): never {
  console.error("Usage: dvdst stage (--input <events.jsonl> | --session-file <session.jsonl>) [--cwd <dir>] [--session <id>] [--dry-run]");
  console.error("Stages only one session's successful edit and write mutations into the git index, using content anchors. Unrelated working-tree changes stay unstaged. Successful bash commands that look file-mutating are listed in unattributedBash but are not staged.");
  process.exit(status);
}

async function main(): Promise<void> {
  const args = process.argv[2] === "stage" ? process.argv.slice(3) : process.argv.slice(2);
  const { values } = parseArgs({
    args,
    options: {
      input: { type: "string", short: "i" },
      "session-file": { type: "string" },
      cwd: { type: "string" },
      session: { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) usage(0);
  if (values.input === undefined && values["session-file"] === undefined) usage();

  const report = await stageChanges({
    ...(values.input === undefined ? {} : { input: values.input }),
    ...(values["session-file"] === undefined ? {} : { sessionFile: values["session-file"] }),
    ...(values.cwd === undefined ? {} : { cwd: values.cwd }),
    ...(values.session === undefined ? {} : { session: values.session }),
    dryRun: values["dry-run"] === true,
    signal: cancellation.signal,
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.conflicts.length > 0) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  const message = error instanceof LiveEventError || error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 2;
} finally {
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
}
