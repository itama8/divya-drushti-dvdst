#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { guardStdout } from "./stdout.js";
import { resolveSession } from "../pi/resolve-sessions.js";
import { buildProbeBundle } from "../probe/build-bundle.js";
import { normalizeSnapshot } from "../normalize/normalize.js";
import { extractSkills } from "../skills/extract.js";
import { exists } from "../store/fs-util.js";
import { readSessionSnapshot } from "../store/read-session.js";

guardStdout();

const DEFAULT_STORE = ".dvdst/store";

function usage(): never {
  console.error("Usage: dvdst files <session> [--path <substring>] [--format json|tsv]");
  console.error("       dvdst commands <session> [--class <test|typecheck|build|lint|dependency>] [--format json|tsv]");
  console.error("       dvdst skills <session> [--format json|tsv]");
  console.error("       dvdst <files|commands|skills> --store <dir> --session <id> [--snapshot <sha256>] [--view invocations|spans|attributions]");
  console.error('A session is a file, a session id or id prefix, or "latest". --view applies to skills in store mode.');
  process.exit(2);
}

function emitTsv(header: string[], rows: unknown[][]): void {
  process.stdout.write(`${header.join("\t")}\n`);
  for (const row of rows) process.stdout.write(`${row.map((value) => `${value ?? ""}`.replace(/\n/g, " ")).join("\t")}\n`);
}

function parseJsonlRows(text: string, filename: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue;
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${filename} line ${index + 1}: not a JSON object`);
    }
    rows.push(value as Record<string, unknown>);
  }
  return rows;
}

function joinPath(path: string, relative: string): string {
  return `${path.replace(/\/+$/, "")}/${relative}`;
}

async function filesFromStore(store: string, sessionId: string, snapshot: string | undefined, pathFilter: string | undefined, format: "json" | "tsv"): Promise<void> {
  const snapshotInfo = await readSessionSnapshot({ store, sessionId, ...(snapshot === undefined ? {} : { sourceHash: snapshot }) });
  const reads = parseJsonlRows(await readFile(joinPath(snapshotInfo.path, "artifacts/file-reads.jsonl"), "utf8"), "file-reads.jsonl");
  const mutations = parseJsonlRows(await readFile(joinPath(snapshotInfo.path, "artifacts/file-mutations.jsonl"), "utf8"), "file-mutations.jsonl");
  const byPath = new Map<string, { operations: Set<string>; count: number }>();
  for (const read of reads) {
    if (typeof read.path !== "string") continue;
    const entry = byPath.get(read.path) ?? { operations: new Set<string>(), count: 0 };
    entry.operations.add("read");
    entry.count += 1;
    byPath.set(read.path, entry);
  }
  for (const mutation of mutations) {
    if (typeof mutation.path !== "string") continue;
    const entry = byPath.get(mutation.path) ?? { operations: new Set<string>(), count: 0 };
    if (typeof mutation.operation === "string") entry.operations.add(mutation.operation);
    entry.count += 1;
    byPath.set(mutation.path, entry);
  }
  const files: Array<{ path: string; operations: string[]; count: number }> = [...byPath.entries()]
    .map(([path, entry]) => ({ path, operations: [...entry.operations], count: entry.count }))
    .sort((left, right) => left.path.localeCompare(right.path))
    .filter((file) => pathFilter === undefined || file.path.includes(pathFilter));
  if (format === "json") process.stdout.write(`${JSON.stringify(files, null, 2)}\n`);
  else emitTsv(["path", "operations", "count"], files.map((file) => [file.path, file.operations.join(","), file.count]));
}

async function commandsFromStore(store: string, sessionId: string, snapshot: string | undefined, classFilter: string | undefined, format: "json" | "tsv"): Promise<void> {
  const snapshotInfo = await readSessionSnapshot({ store, sessionId, ...(snapshot === undefined ? {} : { sourceHash: snapshot }) });
  const rows = parseJsonlRows(await readFile(joinPath(snapshotInfo.path, "artifacts/commands.jsonl"), "utf8"), "commands.jsonl");
  const commands = rows
    .map((command) => ({
      toolCallId: command.toolCallId,
      command: command.command,
      commandPreview: command.commandPreview,
      commandBytes: command.commandBytes,
      commandHash: command.commandHash,
      classes: (command.classifications as Array<{ name: string }> | undefined)?.map((classification) => classification.name) ?? [],
      result: command.result as { isError: boolean; outputBytes: number } | null,
    }))
    .filter((command) => classFilter === undefined || command.classes.includes(classFilter));
  if (format === "json") process.stdout.write(`${JSON.stringify(commands, null, 2)}\n`);
  else emitTsv(["toolCallId", "class", "succeeded", "commandBytes", "resultBytes", "command"], commands.map((command) => [command.toolCallId, command.classes.join("|"), command.result ? (command.result.isError ? "no" : "yes") : "?", command.commandBytes, command.result?.outputBytes ?? 0, command.commandPreview]));
}

async function skillsFromStore(store: string, sessionId: string, snapshot: string | undefined, view: string, format: "json" | "tsv"): Promise<void> {
  const snapshotInfo = await readSessionSnapshot({ store, sessionId, ...(snapshot === undefined ? {} : { sourceHash: snapshot }) });
  if (!(await exists(join(snapshotInfo.path, "records", "entries.jsonl")))) {
    await normalizeSnapshot({ store, sessionId, sourceHash: snapshotInfo.sourceHash });
  }
  const invocationsPath = join(snapshotInfo.path, "records", "skill-invocations.jsonl");
  if (!(await exists(invocationsPath))) {
    await extractSkills({ store, sessionId, sourceHash: snapshotInfo.sourceHash });
  }
  const invocations = parseJsonlRows(await readFile(invocationsPath, "utf8"), "skill-invocations.jsonl");

  if (view === "spans") {
    const spans = invocations
      .map((invocation) => ({
        id: invocation.id,
        name: invocation.name,
        mode: invocation.mode,
        loadStatus: invocation.loadStatus,
        turn: invocation.turn,
        activeStartLine: invocation.activeStartLine ?? null,
        activeEndLine: invocation.activeEndLine,
        boundaryRule: invocation.boundaryRule,
      }))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    if (format === "json") process.stdout.write(`${JSON.stringify(spans, null, 2)}\n`);
    else emitTsv(["id", "name", "mode", "loadStatus", "turn", "activeStartLine", "activeEndLine", "boundaryRule"], spans.map((span) => [span.id, span.name, span.mode, span.loadStatus, span.turn, span.activeStartLine ?? "", span.activeEndLine, span.boundaryRule]));
    return;
  }

  if (view === "attributions") {
    const attributions = parseJsonlRows(await readFile(join(snapshotInfo.path, "records", "skill-attributions.jsonl"), "utf8"), "skill-attributions.jsonl");
    const rowsOut = attributions.map((attribution) => ({
      recordKind: attribution.recordKind,
      recordId: attribution.recordId,
      ...(typeof attribution.role === "string" ? { role: attribution.role } : {}),
      ...(typeof attribution.toolName === "string" ? { toolName: attribution.toolName } : {}),
      labels: attribution.labels as unknown,
    }));
    if (format === "json") process.stdout.write(`${JSON.stringify(rowsOut, null, 2)}\n`);
    else emitTsv(["recordKind", "recordId", "labels"], rowsOut.map((row) => [row.recordKind, row.recordId, (row.labels as Array<{ invocationId: string; basis: string }>).map((label) => label.basis).join(",")]));
    return;
  }

  const skills = invocations.map((invocation) => ({
    id: invocation.id,
    name: invocation.name,
    mode: invocation.mode,
    confidence: invocation.confidence,
    loadStatus: invocation.loadStatus,
    contentHash: invocation.contentHash,
    contentBytes: invocation.contentBytes,
    turn: invocation.turn,
    activeStartLine: invocation.activeStartLine as number | null | undefined,
    activeEndLine: invocation.activeEndLine,
  }));
  if (format === "json") process.stdout.write(`${JSON.stringify(skills, null, 2)}\n`);
  else emitTsv(["id", "name", "mode", "confidence", "loadStatus", "contentBytes", "turn", "activeStartLine", "activeEndLine"], skills.map((skill) => [skill.id, skill.name, skill.mode, skill.confidence, skill.loadStatus, skill.contentBytes, skill.turn, skill.activeStartLine ?? "", skill.activeEndLine]));
}

async function main(): Promise<void> {
  // The dispatcher calls this script with: node --import tsx records.ts <subcommand> [session] [options]
  const subcommand = process.argv[2];
  if (!subcommand) usage();
  if (subcommand !== "files" && subcommand !== "commands" && subcommand !== "skills") usage();

  // Strip subcommand before handing to parseArgs so positionals don't trip strict mode.
  const filtered: string[] = [];
  for (let index = 3; index < process.argv.length; index += 1) filtered.push(process.argv[index]!);
  const { values, positionals } = parseArgs({
    args: filtered,
    options: {
      path: { type: "string" },
      class: { type: "string" },
      view: { type: "string", default: "invocations" },
      store: { type: "string", short: "s" },
      session: { type: "string" },
      snapshot: { type: "string" },
      format: { type: "string", default: "tsv" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
  if (values.help) usage();
  const format = values.format === "json" ? "json" : "tsv";
  const storeMode = values.store !== undefined || values.session !== undefined || values.snapshot !== undefined;
  const sessionPath = positionals[0];

  if (storeMode && sessionPath !== undefined) usage();
  if (storeMode && (values.store === undefined || values.session === undefined)) usage();
  if (subcommand === "skills" && !["invocations", "spans", "attributions"].includes(values.view!)) usage();
  if (subcommand === "files" && values.view !== "invocations") usage();
  if (subcommand === "commands" && values.view !== "invocations") usage();

  if (storeMode) {
    const store = values.store!;
    const sessionId = values.session!;
    if (subcommand === "files") {
      await filesFromStore(store, sessionId, values.snapshot, values.path, format);
    } else if (subcommand === "commands") {
      await commandsFromStore(store, sessionId, values.snapshot, values.class, format);
    } else {
      await skillsFromStore(store, sessionId, values.snapshot, values.view!, format);
    }
    return;
  }

  const bundle = await buildProbeBundle({ sessionPath: await resolveSession(sessionPath) });

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