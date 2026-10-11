#!/usr/bin/env node
import { parseArgs } from "node:util";
import { deriveRows, STREAMS, type Row, type StreamName } from "../analysis/rows.js";
import { loadProjectConfig, type ProjectConfig } from "../config/config.js";
import { isObject } from "../pi/read-jsonl.js";
import { readJsonl } from "../pi/read-jsonl.js";
import { resolveSessions } from "../pi/resolve-sessions.js";
import { guardStdout } from "./stdout.js";

guardStdout();

const STREAM_NAMES = Object.keys(STREAMS) as StreamName[];

function usage(status = 2): never {
  console.error("Usage: dvdst <overview|turns|calls|context> [session...] [--last <n>] [--since <date>] [--root <dir>] [--project <name>]");
  console.error("                                                  [--tool <name>] [--errors] [--full] [--config <file>] [--format jsonl|json|tsv]");
  console.error("       dvdst schema [overview|turns|calls|context] [--format text|json]");
  console.error("");
  for (const name of STREAM_NAMES) console.error(`  ${name.padEnd(9)} ${STREAMS[name].description}`);
  console.error("");
  console.error('A session is a file, a directory, a session id or id prefix, a filename timestamp prefix, or "latest".');
  console.error("With no session, --last and --since select from the Pi session directory of the working directory,");
  console.error("and PI_SESSION_FILE names the current session. Rows go to stdout as JSONL; diagnostics go to stderr.");
  console.error("");
  console.error("  dvdst overview --project omakase-v2 --last 50 | jq -s 'sort_by(-.cost)[:5]'");
  console.error("  dvdst calls latest --errors");
  process.exit(status);
}

function printSchema(stream: string | undefined, format: string): void {
  const names = stream === undefined ? STREAM_NAMES : [stream as StreamName];
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(Object.fromEntries(names.map((name) => [name, STREAMS[name]])), null, 2)}\n`);
    return;
  }
  for (const name of names) {
    process.stdout.write(`${name}: ${STREAMS[name].description}\n`);
    for (const field of STREAMS[name].fields) {
      process.stdout.write(`  ${field.name.padEnd(26)}${field.type.padEnd(15)}${field.description}\n`);
    }
    process.stdout.write("\n");
  }
}

function tsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value) ? value.join(",") : typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.replace(/[\t\n\r]+/g, " ");
}

async function main(): Promise<void> {
  // The dispatcher calls this script with: node --import tsx analysis.ts <subcommand> [...options]
  const subcommand = process.argv[2];
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") usage(subcommand === undefined ? 2 : 0);
  const { values, positionals } = parseArgs({
    args: process.argv.slice(3),
    options: {
      root: { type: "string" },
      project: { type: "string" },
      last: { type: "string" },
      since: { type: "string" },
      tool: { type: "string" },
      errors: { type: "boolean", default: false },
      full: { type: "boolean", default: false },
      config: { type: "string" },
      format: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
  if (values.help) usage(0);

  if (subcommand === "schema") {
    const stream = positionals[0];
    if (positionals.length > 1 || (stream !== undefined && !STREAM_NAMES.includes(stream as StreamName))) usage();
    const format = values.format ?? "text";
    if (format !== "text" && format !== "json") usage();
    printSchema(stream, format);
    return;
  }

  if (!STREAM_NAMES.includes(subcommand as StreamName)) usage();
  const stream = subcommand as StreamName;
  const format = values.format ?? "jsonl";
  if (format !== "jsonl" && format !== "json" && format !== "tsv") usage();
  if ((values.tool !== undefined || values.errors) && stream !== "calls") {
    throw new Error("--tool and --errors filter the calls stream only");
  }

  const paths = await resolveSessions({
    specs: positionals,
    ...(values.root === undefined ? {} : { root: values.root }),
    ...(values.project === undefined ? {} : { project: values.project }),
    ...(values.last === undefined ? {} : { last: Number(values.last) }),
    ...(values.since === undefined ? {} : { since: values.since }),
  });

  // TSV needs fixed columns; the --full fields are free-form, so they stay out of it.
  const columns = STREAMS[stream].fields.map((field) => field.name).filter((name) => !["args", "resultText", "text"].includes(name));
  const collected: Row[] = [];
  let failed = 0;
  if (format === "tsv") process.stdout.write(`${columns.join("\t")}\n`);

  // Each session is classified with the rules of the project it ran in.
  const configs = new Map<string, Promise<ProjectConfig>>();
  const configFor = (cwd: string | undefined): Promise<ProjectConfig> => {
    const key = cwd ?? "";
    let config = configs.get(key);
    if (config === undefined) {
      config = loadProjectConfig({ cwd, configPath: values.config });
      configs.set(key, config);
    }
    return config;
  };

  for (const path of paths) {
    let rows: Row[];
    try {
      const records = await readJsonl(path);
      const header = records.map((record) => record.value).find((value) => isObject(value) && value.type === "session");
      const config = await configFor(isObject(header) && typeof header.cwd === "string" ? header.cwd : undefined);
      const derived = deriveRows(records, path, { full: values.full, commandClasses: config.commandClasses });
      rows = stream === "overview" ? [derived.overview] : derived[stream];
    } catch (error) {
      // One unreadable session, such as one still being appended, must not hide the rest.
      failed += 1;
      console.error(`skipped ${path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (values.tool !== undefined) rows = rows.filter((row) => row.tool === values.tool);
    if (values.errors) rows = rows.filter((row) => row.isError === true);
    for (const row of rows) {
      if (format === "jsonl") process.stdout.write(`${JSON.stringify(row)}\n`);
      else if (format === "tsv") process.stdout.write(`${columns.map((column) => tsvCell(row[column])).join("\t")}\n`);
      else collected.push(row);
    }
  }
  if (format === "json") process.stdout.write(`${JSON.stringify(collected, null, 2)}\n`);
  if (failed > 0) {
    console.error(`${failed} of ${paths.length} sessions could not be read`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
