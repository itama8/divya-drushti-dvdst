#!/usr/bin/env node
import { guardStdout } from "./stdout.js";
import { parseArgs } from "node:util";
import { buildProbeBundle } from "../probe/build-bundle.js";

guardStdout();

function usage(): never {
  console.error("Usage: dvdst trace <session.jsonl> --id <recordId> [--format json|tsv|text]");
  process.exit(2);
}

async function main(): Promise<void> {
  const subcommand = process.argv[2];
  const sessionPath = process.argv[3];
  if (subcommand !== "trace") usage();
  if (!sessionPath || sessionPath.startsWith("-")) usage();

  const filtered: string[] = [];
  for (let index = 4; index < process.argv.length; index += 1) filtered.push(process.argv[index]!);
  const { values } = parseArgs({
    args: filtered,
    options: {
      id: { type: "string", short: "i" },
      format: { type: "string", default: "text" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) usage();
  if (typeof values.id !== "string") usage();
  const recordId = values.id;
  const format = values.format === "json" || values.format === "tsv" ? values.format : "text";

  const bundle = await buildProbeBundle({ sessionPath });
  const skillAttributions = bundle.skills.attributedRecords as Array<{ recordId?: string; recordKind?: string; labels?: Array<{ invocationId: string; basis: string }> }>;
  const skillInvocations = bundle.skills.invocations as Array<{ id: string; name: string; mode: string; activeStartLine: number | undefined; activeEndLine: number }>;
  const messages = bundle.goals as unknown[]; // goals reuse the same shape briefly
  const files = bundle.files as Array<{ path: string; firstSource: { line: number; byteStart: number; byteEnd: number }; lastSource: { line: number; byteStart: number; byteEnd: number } }>;
  const commands = bundle.commands as Array<{ toolCallId: string; source: { line: number } }>;

  const attributions = skillAttributions.filter((entry) => entry.recordId === recordId);
  const invocation = skillInvocations.find((skill) => skill.id === recordId);
  const fileEntry = files.find((file) => file.path === recordId);
  const commandEntry = commands.find((command) => command.toolCallId === recordId);

  if (format === "json") {
    process.stdout.write(`${JSON.stringify({ attributions, invocation, fileEntry, commandEntry }, null, 2)}\n`);
    return;
  }

  if (format === "tsv") {
    process.stdout.write(`field\tvalue\n`);
    process.stdout.write(`recordId\t${recordId}\n`);
    if (invocation) {
      process.stdout.write(`invocation\t${invocation.id}\tname=${invocation.name}\tmode=${invocation.mode}\n`);
    }
    if (fileEntry) {
      process.stdout.write(`file\t${fileEntry.path}\tfirstLine=${fileEntry.firstSource.line}\tlastLine=${fileEntry.lastSource.line}\n`);
    }
    if (commandEntry) {
      process.stdout.write(`command\t${commandEntry.toolCallId}\tline=${commandEntry.source.line}\n`);
    }
    for (const attribution of attributions) {
      process.stdout.write(`attribution\tkind=${attribution.recordKind}\t`);
      for (const label of attribution.labels ?? []) process.stdout.write(`invocation=${label.invocationId} basis=${label.basis} `);
      process.stdout.write("\n");
    }
    return;
  }

  if (invocation) {
    process.stdout.write(`Skill invocation: ${invocation.id}\n`);
    process.stdout.write(`  name: ${invocation.name}\n  mode: ${invocation.mode}\n  active lines: ${invocation.activeStartLine ?? "?"}..${invocation.activeEndLine}\n`);
  }
  if (fileEntry) {
    process.stdout.write(`File: ${fileEntry.path}\n`);
    process.stdout.write(`  first line: ${fileEntry.firstSource.line}\n  last line: ${fileEntry.lastSource.line}\n`);
  }
  if (commandEntry) {
    process.stdout.write(`Command: ${commandEntry.toolCallId}\n  source line: ${commandEntry.source.line}\n`);
  }
  if (attributions.length > 0) {
    process.stdout.write(`Attributions: ${attributions.length}\n`);
    for (const attribution of attributions) {
      const labels = (attribution.labels ?? []).map((label) => `${label.invocationId} (${label.basis})`).join(", ");
      process.stdout.write(`  ${attribution.recordKind}: ${labels}\n`);
    }
  }
  if (!invocation && !fileEntry && !commandEntry && attributions.length === 0) {
    process.stdout.write(`No record found for id ${recordId}\n`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
