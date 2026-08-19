#!/usr/bin/env node
import { guardStdout } from "./stdout.js";
import { parseArgs } from "node:util";
import { buildProbeBundle } from "../probe/build-bundle.js";

guardStdout();

function usage(): never {
  console.error("Usage: dvdst files <session.jsonl> [--path <substring>] [--format json|tsv]");
  console.error("       dvdst commands <session.jsonl> [--class <test|typecheck|build|lint>] [--format json|tsv]");
  console.error("       dvdst skills <session.jsonl> [--format json|tsv]");
  process.exit(2);
}

function emitTsv(header: string[], rows: unknown[][]): void {
  process.stdout.write(`${header.join("\t")}\n`);
  for (const row of rows) process.stdout.write(`${row.map((value) => `${value ?? ""}`.replace(/\n/g, " ")).join("\t")}\n`);
}

async function main(): Promise<void> {
  // The dispatcher calls this script with: node --import tsx records.ts <subcommand> <session> [...options]
  const subcommand = process.argv[2];
  const sessionPath = process.argv[3];
  if (!subcommand) usage();
  if (subcommand !== "files" && subcommand !== "commands" && subcommand !== "skills") usage();
  if (!sessionPath || sessionPath.startsWith("-")) usage();

  // Strip subcommand and session before handing to parseArgs so positionals don't trip strict mode.
  const filtered: string[] = [];
  for (let index = 4; index < process.argv.length; index += 1) filtered.push(process.argv[index]!);
  const { values } = parseArgs({
    args: filtered,
    options: {
      path: { type: "string" },
      class: { type: "string" },
      format: { type: "string", default: "tsv" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) usage();
  const format = values.format === "json" ? "json" : "tsv";

  const bundle = await buildProbeBundle({ sessionPath });

  if (subcommand === "files") {
    const pathFilter = typeof values.path === "string" ? values.path : undefined;
    const files = (bundle.files as Array<{ path: string; operations: string[]; count: number }>)
      .filter((file) => pathFilter === undefined || file.path.includes(pathFilter));
    if (format === "json") process.stdout.write(`${JSON.stringify(files, null, 2)}\n`);
    else emitTsv(["path", "operations", "count"], files.map((file) => [file.path, file.operations.join(","), file.count]));
    return;
  }

  if (subcommand === "commands") {
    const classFilter = typeof values.class === "string" ? values.class : undefined;
    const commands = (bundle.commands as Array<{ toolCallId: string; commandPreview: string; commandBytes: number; classes: string[]; result?: { isError: boolean; textBytes: number } }>)
      .filter((command) => classFilter === undefined || command.classes.includes(classFilter));
    if (format === "json") process.stdout.write(`${JSON.stringify(commands, null, 2)}\n`);
    else emitTsv(["toolCallId", "class", "succeeded", "commandBytes", "resultBytes", "command"], commands.map((command) => [command.toolCallId, command.classes.join("|"), command.result ? (command.result.isError ? "no" : "yes") : "?", command.commandBytes, command.result?.textBytes ?? 0, command.commandPreview]));
    return;
  }

  const skills = bundle.skills.invocations as Array<{ id: string; name: string; mode: string; confidence: string; contentBytes: number; turn: number; activeStartLine: number | undefined; activeEndLine: number }>;
  if (format === "json") process.stdout.write(`${JSON.stringify(skills, null, 2)}\n`);
  else emitTsv(["id", "name", "mode", "confidence", "contentBytes", "turn", "activeStartLine", "activeEndLine"], skills.map((skill) => [skill.id, skill.name, skill.mode, skill.confidence, skill.contentBytes, skill.turn, skill.activeStartLine ?? "", skill.activeEndLine]));
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
