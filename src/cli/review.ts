#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { guardStdout } from "./stdout.js";
import { LiveDecomposer, LiveEventError, parseLiveEvent } from "../live/decompose.js";
import { LiveReviewReducer } from "../live/review.js";

guardStdout();

function usage(status = 2): never {
  console.error("Usage: dvdst review --input <events.jsonl> [--watch] [--interval-ms <milliseconds>]");
  console.error("Consumes the append-only Pi extension stream and emits a review-ready JSON record when Pi settles after completed file mutations.");
  process.exit(status);
}

class LiveReviewReader {
  private readonly decomposer = new LiveDecomposer();
  private readonly reducer = new LiveReviewReducer();
  private offset = 0;
  private pending = Buffer.alloc(0);
  private line = 1;

  async read(path: string): Promise<void> {
    const source = await readFile(path);
    if (source.length < this.offset) {
      throw new Error("live stream shrank while watching; refuse to replay a source that is required to be append-only");
    }
    const chunk = source.subarray(this.offset);
    this.offset = source.length;
    this.pending = Buffer.concat([this.pending, chunk]);
    let newline: number;
    while ((newline = this.pending.indexOf(0x0a)) >= 0) {
      const text = this.pending.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      this.pending = this.pending.subarray(newline + 1);
      const event = parseLiveEvent(text, this.line);
      if (event) {
        this.decomposer.ingest(event, this.line);
        const review = this.reducer.ingest(event);
        if (review) process.stdout.write(`${JSON.stringify(review)}\n`);
      }
      this.line += 1;
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv[2] === "review" ? process.argv.slice(3) : process.argv.slice(2);
  const { values } = parseArgs({
    args,
    options: {
      input: { type: "string", short: "i" },
      watch: { type: "boolean", short: "w" },
      "interval-ms": { type: "string", default: "1000" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) usage(0);
  if (values.input === undefined) usage();
  const interval = Number(values["interval-ms"]);
  if (!Number.isSafeInteger(interval) || interval < 100) {
    throw new Error("--interval-ms must be a whole number of at least 100");
  }

  const reader = new LiveReviewReader();
  do {
    await reader.read(values.input);
    if (!values.watch) break;
    await new Promise<void>((resolve) => setTimeout(resolve, interval));
  } while (true);
}

try {
  await main();
} catch (error) {
  const message = error instanceof LiveEventError || error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
