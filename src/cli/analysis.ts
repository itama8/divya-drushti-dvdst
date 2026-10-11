#!/usr/bin/env node
import { parseArgs } from "node:util";
import { extractorDirectories, findExtractor, listExtractorFiles, loadExtractorFile, type LoadedExtractor } from "../analysis/extractors.js";
import { STREAMS, type FieldSpec, type Row, type StreamName } from "../analysis/rows.js";
import { loadSessionFile } from "../analysis/session.js";
import { resolveSessions, type SourceSelection } from "../pi/resolve-sessions.js";
import { guardStdout } from "./stdout.js";

guardStdout();

const STREAM_NAMES = Object.keys(STREAMS) as StreamName[];
/** Fields that only --full adds. They are free-form, so they stay out of TSV. */
const FULL_ONLY = ["args", "resultText", "text"];

function usage(status = 2): never {
  console.error("Usage: dvdst <overview|turns|calls|context> [session...] [--last <n>] [--since <date>] [--root <dir>] [--project <name>] [--source pi|claude|all]");
  console.error("                                                  [--tool <name>] [--errors] [--full] [--config <file>] [--format jsonl|json|tsv]");
  console.error("       dvdst rows <extractor|file> [session...]   run a project extractor with the same selection and format options");
  console.error("       dvdst schema [stream|extractor] [--format text|json]");
  console.error("");
  for (const name of STREAM_NAMES) console.error(`  ${name.padEnd(9)} ${STREAMS[name].description}`);
  console.error("");
  console.error('A session is a file, a directory, a session id or id prefix, a filename timestamp prefix, or "latest".');
  console.error("With no session, --last and --since select from the Pi session directory of the working directory,");
  console.error("and PI_SESSION_FILE names the current session. Rows go to stdout as JSONL; diagnostics go to stderr.");
  console.error("Pi and Claude Code sessions are both read. latest, --last, and --since select Pi sessions unless --source says otherwise.");
  console.error("");
  console.error("An extractor is a file in .dvdst/extractors/ that default-exports { derive(session) }.");
  console.error("`dvdst <name>` runs it. See docs/extractors.md.");
  console.error("");
  console.error("  dvdst overview --project omakase-v2 --last 50 | jq -s 'sort_by(-.cost)[:5]'");
  console.error("  dvdst calls latest --errors");
  process.exit(status);
}

function printFields(name: string, description: string, fields: FieldSpec[] | undefined, note?: string): void {
  process.stdout.write(`${name}: ${description}\n`);
  if (note !== undefined) process.stdout.write(`  ${note}\n`);
  for (const field of fields ?? []) process.stdout.write(`  ${field.name.padEnd(26)}${field.type.padEnd(15)}${field.description}\n`);
  if (fields === undefined) process.stdout.write("  (the extractor declares no fields)\n");
  process.stdout.write("\n");
}

async function printSchema(target: string | undefined, format: string): Promise<void> {
  const extractors: LoadedExtractor[] = [];
  if (target === undefined) {
    for (const file of (await listExtractorFiles()).values()) extractors.push(await loadExtractorFile(file));
  } else if (!STREAM_NAMES.includes(target as StreamName)) {
    const extractor = await findExtractor(target);
    if (extractor === undefined) throw new Error(`No stream or extractor named ${JSON.stringify(target)}. Extractors are looked up in ${extractorDirectories().join(", ")}.`);
    extractors.push(extractor);
  }
  const builtIn = target === undefined ? STREAM_NAMES : STREAM_NAMES.filter((name) => name === target);

  if (format === "json") {
    const schema: Record<string, unknown> = Object.fromEntries(builtIn.map((name) => [name, STREAMS[name]]));
    for (const extractor of extractors) {
      schema[extractor.name] = { description: extractor.description, fields: extractor.fields ?? null, file: extractor.file, summarizes: extractor.summarize !== undefined };
    }
    process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
    return;
  }
  for (const name of builtIn) printFields(name, STREAMS[name].description, STREAMS[name].fields);
  for (const extractor of extractors) printFields(extractor.name, extractor.description, extractor.fields, `extractor ${extractor.file}`);
}

function tsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value) ? value.join(",") : typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.replace(/[\t\n\r]+/g, " ");
}

function writeTsv(columns: string[], rows: Row[]): void {
  process.stdout.write(`${columns.join("\t")}\n`);
  for (const row of rows) process.stdout.write(`${columns.map((column) => tsvCell(row[column])).join("\t")}\n`);
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
      source: { type: "string" },
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
    if (positionals.length > 1) usage();
    const format = values.format ?? "text";
    if (format !== "text" && format !== "json") usage();
    await printSchema(positionals[0], format);
    return;
  }

  // `rows <name>` names the stream explicitly; `dvdst <name>` reaches here for a built-in stream or an extractor.
  let streamName = subcommand;
  let specs = positionals;
  if (subcommand === "rows") {
    if (positionals.length === 0) usage();
    streamName = positionals[0]!;
    specs = positionals.slice(1);
  }
  const builtIn = STREAM_NAMES.includes(streamName as StreamName) ? (streamName as StreamName) : undefined;
  const extractor = builtIn === undefined ? await findExtractor(streamName) : undefined;
  if (builtIn === undefined && extractor === undefined) {
    throw new Error(`Unknown command or extractor ${JSON.stringify(streamName)}. Run dvdst --help for commands. Extractors are looked up in ${extractorDirectories().join(", ")}.`);
  }

  const format = values.format ?? "jsonl";
  if (format !== "jsonl" && format !== "json" && format !== "tsv") usage();
  if ((values.tool !== undefined || values.errors) && builtIn !== "calls") {
    throw new Error("--tool and --errors filter the calls stream only");
  }

  const paths = await resolveSessions({
    specs,
    ...(values.root === undefined ? {} : { root: values.root }),
    ...(values.project === undefined ? {} : { project: values.project }),
    ...(values.last === undefined ? {} : { last: Number(values.last) }),
    ...(values.since === undefined ? {} : { since: values.since }),
    ...(values.source === undefined ? {} : { source: values.source as SourceSelection }),
  });

  // Built-in rows stream out per session. Extractor rows are held to the end,
  // because a summarize step and undeclared TSV columns need all of them.
  const streaming = extractor === undefined && format !== "json";
  const builtInColumns = builtIn === undefined ? [] : STREAMS[builtIn].fields.map((field) => field.name).filter((name) => !FULL_ONLY.includes(name));
  const collected: Row[] = [];
  let failed = 0;
  if (streaming && format === "tsv") process.stdout.write(`${builtInColumns.join("\t")}\n`);

  for (const path of paths) {
    let rows: Row[];
    try {
      // An extractor always gets arguments and result text; it decides what to keep.
      const session = await loadSessionFile(path, { full: values.full || extractor !== undefined, ...(values.config === undefined ? {} : { configPath: values.config }) });
      if (extractor !== undefined) rows = [...(await extractor.derive(session))];
      else rows = builtIn === "overview" ? [session.overview] : session[builtIn!];
    } catch (error) {
      // One unreadable session, such as one still being appended, must not hide the rest.
      failed += 1;
      console.error(`skipped ${path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (values.tool !== undefined) rows = rows.filter((row) => row.tool === values.tool);
    if (values.errors) rows = rows.filter((row) => row.isError === true);
    if (!streaming) collected.push(...rows);
    else if (format === "jsonl") for (const row of rows) process.stdout.write(`${JSON.stringify(row)}\n`);
    else for (const row of rows) process.stdout.write(`${builtInColumns.map((column) => tsvCell(row[column])).join("\t")}\n`);
  }

  if (!streaming) {
    const rows = extractor?.summarize === undefined ? collected : await extractor.summarize(collected);
    if (format === "json") process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    else if (format === "jsonl") for (const row of rows) process.stdout.write(`${JSON.stringify(row)}\n`);
    else {
      const declared = extractor?.fields?.map((field) => field.name);
      writeTsv(declared ?? [...new Set(rows.flatMap((row) => Object.keys(row)))], rows);
    }
  }
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
