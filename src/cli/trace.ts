#!/usr/bin/env node
import { guardStdout } from "./stdout.js";
import { parseArgs } from "node:util";
import { resolveSession } from "../pi/resolve-sessions.js";
import { buildProbeBundle } from "../probe/build-bundle.js";
import { loadSessionFile } from "../analysis/session.js";
import { isObject } from "../pi/read-jsonl.js";

guardStdout();

function usage(status = 2): never {
  console.error("Usage: dvdst trace <session> --id <recordId> [--format json|tsv|text]");
  process.exit(status);
}

async function main(): Promise<void> {
  const subcommand = process.argv[2];
  const sessionPath = process.argv[3];
  if (subcommand !== "trace") usage();
  if (sessionPath === "--help" || sessionPath === "-h") usage(0);
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

  if (values.help) usage(0);
  if (typeof values.id !== "string") usage();
  const recordId = values.id;
  if (!["json", "tsv", "text"].includes(values.format!)) throw new Error("--format must be json, tsv, or text.");
  const format = values.format!;

  const path = await resolveSession(sessionPath);
  const [bundle, session] = await Promise.all([buildProbeBundle({ sessionPath: path }), loadSessionFile(path, { full: false })]);
  const skillAttributions = bundle.skills.attributedRecords as Array<{ recordId?: string; recordKind?: string; labels?: Array<{ invocationId: string; basis: string }> }>;
  const skillInvocations = bundle.skills.invocations as Array<{ id: string; name: string; mode: string; activeStartLine: number | undefined; activeEndLine: number }>;
  const files = bundle.files as Array<{ path: string; firstSource: { line: number; byteStart: number; byteEnd: number }; lastSource: { line: number; byteStart: number; byteEnd: number } }>;
  const commands = bundle.commands as Array<{ toolCallId: string; source: { line: number } }>;

  const attributions = skillAttributions.filter((entry) => entry.recordId === recordId);
  const invocation = skillInvocations.find((skill) => skill.id === recordId);
  const fileEntry = files.find((file) => file.path === recordId);
  const commandEntry = commands.find((command) => command.toolCallId === recordId);
  const callEntries = session.calls.filter(call => call.callId === recordId).map(({ callId, tool, line, resultLine, ref }) => ({ callId, tool, line, resultLine, ref }));
  const records = session.records.filter(record => isObject(record.value) && (record.value.id === recordId || (isObject(record.value.message) && record.value.message.id === recordId))).map(record => record.source);
  const found = Boolean(invocation || fileEntry || commandEntry || attributions.length || callEntries.length || records.length);
  if (!found) process.exitCode = 1;

  if (format === "json") {
    process.stdout.write(`${JSON.stringify({ found, session: session.session, path, callEntries, records, attributions, invocation, fileEntry, commandEntry }, null, 2)}\n`);
    return;
  }

  if (format === "tsv") {
    process.stdout.write(`field\tvalue\n`);
    process.stdout.write(`recordId\t${recordId}\n`);
    process.stdout.write(`found\t${found}\n`);
    for (const call of callEntries) process.stdout.write(`call\t${call.callId}\tline=${call.line}\tresultLine=${call.resultLine ?? "?"}\n`);
    for (const record of records) process.stdout.write(`record\tline=${record.line}\n`);
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

  for (const call of callEntries) process.stdout.write(`Call: ${call.callId}\n  tool: ${call.tool}\n  source line: ${call.line}\n  result line: ${call.resultLine ?? "?"}\n`);
  for (const record of records) process.stdout.write(`Record: ${recordId}\n  source line: ${record.line}\n`);
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
  if (!found) {
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
