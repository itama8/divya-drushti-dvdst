#!/usr/bin/env node
import { parseArgs } from "node:util";
import { extractorDirectories, findExtractor, listExtractorFiles, loadExtractorFile, type LoadedExtractor } from "../analysis/extractors.js";
import { STREAMS, type FieldSpec, type Row, type StreamName } from "../analysis/rows.js";
import { cacheUsage, clearCache } from "../analysis/cache.js";
import { loadSessionFile, loadSessionRows } from "../analysis/session.js";
import { resolveSessions, type SourceSelection } from "../pi/resolve-sessions.js";
import { guardStdout } from "./stdout.js";
import { CALL_SCHEMA, integerOption } from "../analysis/read-call.js";
import { MESSAGES_SCHEMA, MESSAGE_SCHEMA, SEARCH_SCHEMA } from "../analysis/conversation-schema.js";

guardStdout();

const STREAM_NAMES = Object.keys(STREAMS) as StreamName[];
const EXPLORATION_SCHEMAS = { call: CALL_SCHEMA, messages: MESSAGES_SCHEMA, message: MESSAGE_SCHEMA, search: SEARCH_SCHEMA };
/** Fields that only --full adds. They are free-form, so they stay out of TSV. */
const FULL_ONLY = ["args", "resultText", "text"];

function usage(status = 2): never {
  console.error("Usage: dvdst <overview|turns|calls|context> [session...] [--last <n>] [--since <date>] [--root <dir>] [--project <name>] [--source pi|claude|codex|all]");
  console.error("                                                  [--tool <name>] [--errors] [--full] [--config <file>] [--no-cache] [--format jsonl|json|tsv]");
  console.error("       calls also accepts --id <callId>, --seq <n>, --class <name>.");
  console.error("       Built-in streams accept --fields <comma-separated names>, --limit <rows>, --offset <rows> (after filtering, across sessions).");
  console.error("       dvdst rows <extractor|file> [session...]   run a project extractor with the same selection and format options");
  console.error("       dvdst schema [stream|extractor] [--format text|json]");
  console.error("       dvdst cache [--clear]                       show or empty the row cache");
  console.error("");
  for (const name of STREAM_NAMES) console.error(`  ${name.padEnd(9)} ${STREAMS[name].description}`);
  console.error("");
  console.error('A session is a file, a directory, a session id or id prefix, a filename timestamp prefix, or "latest".');
  console.error("With no session, --last and --since select from the Pi session directory of the working directory,");
  console.error("and PI_SESSION_FILE names the current session. Rows go to stdout as JSONL; diagnostics go to stderr.");
  console.error("Pi, Claude Code, and Codex sessions are read. latest, --last, and --since select Pi sessions unless --source says otherwise.");
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
  if (target !== undefined && Object.hasOwn(EXPLORATION_SCHEMAS, target)) {
    const schema = EXPLORATION_SCHEMAS[target as keyof typeof EXPLORATION_SCHEMAS];
    if (format === "json") process.stdout.write(`${JSON.stringify({ [target]: schema }, null, 2)}\n`);
    else printFields(target, schema.description, schema.fields);
    return;
  }
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
    if (target === undefined) Object.assign(schema, EXPLORATION_SCHEMAS);
    for (const extractor of extractors) {
      schema[extractor.name] = { description: extractor.description, fields: extractor.fields ?? null, file: extractor.file, summarizes: extractor.summarize !== undefined };
    }
    process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
    return;
  }
  for (const name of builtIn) printFields(name, STREAMS[name].description, STREAMS[name].fields);
  if (target === undefined) for (const [name, spec] of Object.entries(EXPLORATION_SCHEMAS)) printFields(name, spec.description, spec.fields);
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
      id: { type: "string" },
      seq: { type: "string" },
      class: { type: "string" },
      fields: { type: "string" },
      limit: { type: "string" },
      offset: { type: "string" },
      errors: { type: "boolean", default: false },
      full: { type: "boolean", default: false },
      config: { type: "string" },
      "no-cache": { type: "boolean", default: false },
      clear: { type: "boolean", default: false },
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

  if (subcommand === "cache") {
    if (positionals.length > 0) usage();
    if (values.clear) await clearCache();
    process.stdout.write(`${JSON.stringify(await cacheUsage())}\n`);
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
  if ((values.tool !== undefined || values.errors || values.id !== undefined || values.seq !== undefined || values.class !== undefined) && builtIn !== "calls") {
    throw new Error("--tool, --errors, --id, --seq and --class filter the calls stream only");
  }
  const limit = integerOption(values.limit, "--limit", 1);
  let skip = integerOption(values.offset, "--offset", 0) ?? 0;
  const seq = integerOption(values.seq, "--seq", 1);
  const fields = values.fields?.split(",");
  if (builtIn === undefined && (fields !== undefined || limit !== undefined || values.offset !== undefined)) throw new Error("--fields, --limit and --offset currently apply to built-in streams only.");
  if (fields !== undefined) {
    const declared = STREAMS[builtIn!].fields.map(field => field.name);
    if (fields.some(name => !declared.includes(name)) || new Set(fields).size !== fields.length) throw new Error(`Invalid or duplicate --fields. Run dvdst schema ${builtIn}.`);
    if (!values.full && fields.some(name => FULL_ONLY.includes(name))) throw new Error("Payload fields require --full.");
  }
  let emitted = 0;

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
  const builtInColumns = fields ?? (builtIn === undefined ? [] : STREAMS[builtIn].fields.map((field) => field.name).filter((name) => !FULL_ONLY.includes(name)));
  const collected: Row[] = [];
  let failed = 0;
  if (streaming && format === "tsv") process.stdout.write(`${builtInColumns.join("\t")}\n`);

  for (const path of paths) {
    let rows: Row[];
    try {
      const config = values.config === undefined ? {} : { configPath: values.config };
      if (extractor !== undefined) {
        // An extractor always gets arguments and result text; it decides what to keep.
        rows = [...(await extractor.derive(await loadSessionFile(path, { full: true, ...config })))];
      } else {
        // Rows without payloads come from the cache when the session is unchanged.
        const session = values.full ? await loadSessionFile(path, { full: true, ...config }) : await loadSessionRows(path, { ...config, cache: !values["no-cache"] });
        rows = builtIn === "overview" ? [session.overview] : session[builtIn!];
      }
    } catch (error) {
      // One unreadable session, such as one still being appended, must not hide the rest.
      failed += 1;
      console.error(`skipped ${path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (values.tool !== undefined) rows = rows.filter((row) => row.tool === values.tool);
    if (values.errors) rows = rows.filter((row) => row.isError === true);
    if (values.id !== undefined) rows = rows.filter(row => row.callId === values.id);
    if (seq !== undefined) rows = rows.filter(row => row.seq === seq);
    if (values.class !== undefined) rows = rows.filter(row => (row.classes as string[]).includes(values.class!));
    if (builtIn !== undefined) {
      const dropped = Math.min(skip, rows.length);
      skip -= dropped;
      rows = rows.slice(dropped, limit === undefined ? undefined : dropped + Math.max(0, limit - emitted));
      emitted += rows.length;
      if (fields !== undefined) rows = rows.map(row => Object.fromEntries(fields.map(name => [name, row[name] ?? null])));
    }
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
