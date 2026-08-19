#!/usr/bin/env node
import { guardStdout } from "./stdout.js";
import { createReadStream } from "node:fs";
import { parseArgs } from "node:util";
import { LiveDecomposer, LiveEventError, parseLiveEvent } from "../live/decompose.js";

guardStdout();

function usage(status = 2): never {
  console.error("Usage: dvdst live [--input <events.jsonl>]");
  console.error("Reads canonical live-event JSONL from --input or stdin and emits observed evidence JSONL.");
  process.exit(status);
}

async function main(): Promise<void> {
  // The dispatcher forwards the subcommand as argv[2]. Direct execution does not.
  const args = process.argv[2] === "live" ? process.argv.slice(3) : process.argv.slice(2);
  const { values } = parseArgs({
    args,
    options: {
      input: { type: "string", short: "i" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) usage(0);

  const input = values.input ? createReadStream(values.input, { encoding: "utf8" }) : process.stdin;
  const decomposer = new LiveDecomposer();
  let pending = "";
  let line = 1;

  for await (const chunk of input) {
    pending += chunk;
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const text = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      const event = parseLiveEvent(text, line);
      if (event) process.stdout.write(`${JSON.stringify(decomposer.ingest(event, line))}\n`);
      line += 1;
    }
  }
  if (pending.length > 0) {
    const event = parseLiveEvent(pending.replace(/\r$/, ""), line);
    if (event) process.stdout.write(`${JSON.stringify(decomposer.ingest(event, line))}\n`);
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof LiveEventError || error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
