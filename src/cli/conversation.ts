import { CLI_OPTIONS, parserOptions, CONVERSATION_ALLOWED } from "./command-options.js";
import { parseArgs } from "node:util";
import { loadConversation, listMessages, readMessage, searchConversation, validateRoles, type RoleSelection, type SearchScope } from "../analysis/conversation.js";
import { MESSAGES_SCHEMA, SEARCH_SCHEMA } from "../analysis/conversation-schema.js";
import { integerOption } from "../analysis/read-call.js";
import { resolveSessions, type SourceSelection } from "../pi/resolve-sessions.js";
import { guardStdout } from "./stdout.js";

guardStdout();

function help() {
  console.error("Usage: dvdst messages [session...] [--role user,assistant|all] [--limit rows] [--offset rows] [--text-limit chars]");
  console.error("       dvdst search [session...] --query <literal> [--in messages|commands|results|all] [--ignore-case] [--role roles]");
  console.error("       Both accept --source pi|claude|codex|all, --project <name>, --root <dir>, --last <n>, --since <date>,");
  console.error("                   --fields <names>, --limit <rows>, --offset <rows>, --text-limit <chars>, --format jsonl|json|tsv, --page.");
  console.error("       --page returns a JSON envelope with matched, nextOffset, complete, and failedSources. Default: 20 rows, 240 chars per excerpt.");
  console.error("       dvdst message <session> --seq <n> [--before <n>] [--after <n>] [--limit chars] [--text-offset <n>]");
  console.error("       dvdst message --ref <messageRef> [--before <n>] [--after <n>] [--limit chars] [--text-offset <n>]");
  console.error("       message returns JSON. Default: 2 neighbors each side, 2000 chars per message; --text-offset applies to the anchor only.");
  console.error("       message --ref also accepts a call ref to anchor at the requesting assistant message.");
  console.error("Run dvdst schema messages, dvdst schema search, or dvdst schema message for output fields.");
}

function cell(value: unknown): string {
  return (value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value)).replace(/[\t\n\r]/g, " ");
}

async function main() {
  const command = process.argv[2];
  if (!["messages", "search", "message"].includes(command ?? "")) throw new Error("Expected messages, search, or message.");
  const { values, positionals } = parseArgs({ args: process.argv.slice(3), allowPositionals: true, options: parserOptions(CLI_OPTIONS.conversation) });
  if (values.help) { help(); return; }
  const allowed = new Set<string>(CONVERSATION_ALLOWED[command as keyof typeof CONVERSATION_ALLOWED]);
  for (const name of Object.keys(values)) if (!allowed.has(name)) throw new Error(`--${name} does not apply to ${command}. Run dvdst ${command} --help.`);

  if (command === "message") {
    if (positionals.length > 1) throw new Error("Expected at most one session. Run dvdst message --help.");
    if (values.format !== undefined && values.format !== "json") throw new Error("message supports --format json only.");
    const result = await readMessage({
      ...(positionals[0] === undefined ? {} : { session: positionals[0] }),
      ...(values.ref === undefined ? {} : { ref: values.ref }),
      ...(values.seq === undefined ? {} : { seq: integerOption(values.seq, "--seq", 1)! }),
      ...(values.before === undefined ? {} : { before: integerOption(values.before, "--before", 0, 10)! }),
      ...(values.after === undefined ? {} : { after: integerOption(values.after, "--after", 0, 10)! }),
      ...(values.limit === undefined ? {} : { limit: integerOption(values.limit, "--limit", 1, 65536)! }),
      ...(values["text-offset"] === undefined ? {} : { textOffset: integerOption(values["text-offset"], "--text-offset", 0)! }),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (command === "search" && (values.query === undefined || values.query.length === 0)) throw new Error("search requires a nonempty --query <literal>.");
  const scope = values.in ?? "messages";
  if (!["messages", "commands", "results", "all"].includes(scope)) throw new Error("--in must be messages, commands, results, or all.");
  const roles: RoleSelection | undefined = values.role === undefined ? undefined : values.role === "all" ? "all" : values.role.split(",");
  validateRoles(roles);
  const limit = integerOption(values.limit ?? "20", "--limit", 1)!;
  const offset = integerOption(values.offset ?? "0", "--offset", 0)!;
  const textLimit = integerOption(values["text-limit"] ?? "240", "--text-limit", 1, 4096)!;
  const format = values.format ?? (values.page ? "json" : "jsonl");
  if (!["jsonl", "json", "tsv"].includes(format)) throw new Error("--format must be jsonl, json, or tsv.");
  if (values.page && format !== "json") throw new Error("--page requires JSON output; omit --format or use --format json.");
  const schema = command === "messages" ? MESSAGES_SCHEMA : SEARCH_SCHEMA;
  const fields = values.fields?.split(",") ?? schema.fields.map(field => field.name);
  if (new Set(fields).size !== fields.length || fields.some(name => !schema.fields.some(field => field.name === name))) throw new Error(`Invalid or duplicate --fields. Run dvdst schema ${command}.`);
  const paths = await resolveSessions({ specs: positionals,
    ...(values.source === undefined ? {} : { source: values.source as SourceSelection }),
    ...(values.project === undefined ? {} : { project: values.project }),
    ...(values.root === undefined ? {} : { root: values.root }),
    ...(values.last === undefined ? {} : { last: integerOption(values.last, "--last", 1)! }),
    ...(values.since === undefined ? {} : { since: values.since }),
  });
  const rows: Array<Record<string, unknown>> = [];
  const failures: Array<{ path: string; error: string }> = [];
  let skip = offset;
  let returned = 0;
  let matched = 0;
  if (format === "tsv") process.stdout.write(`${fields.join("\t")}\n`);
  for (const path of paths) {
    try {
      const conversation = await loadConversation(path);
      const options = { offset: skip, limit: Math.max(1, limit - returned), textLimit, ...(roles === undefined ? {} : { roles }) };
      const page = command === "messages" ? listMessages(conversation, options)
        : searchConversation(conversation, { ...options, query: values.query!, scope: scope as SearchScope, ignoreCase: values["ignore-case"] ?? false });
      matched += page.matched;
      skip -= Math.min(skip, page.matched);
      const selected = returned < limit ? page.rows : [];
      returned += selected.length;
      for (const item of selected) {
        const row = Object.fromEntries(fields.map(name => [name, (item as unknown as Record<string, unknown>)[name] ?? null]));
        if (format === "json") rows.push(row);
        else if (format === "jsonl") process.stdout.write(`${JSON.stringify(row)}\n`);
        else process.stdout.write(`${fields.map(name => cell(row[name])).join("\t")}\n`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ path, error: message });
      console.error(`skipped ${path}: ${message}`);
    }
  }
  if (format === "json") process.stdout.write(`${JSON.stringify(values.page ? {
    schemaVersion: 1, rows, matched, returned, nextOffset: offset + returned < matched ? offset + returned : null,
    complete: failures.length === 0, selectedSources: paths.length, readSources: paths.length - failures.length, failedSources: failures,
  } : rows)}\n`);
  if (failures.length > 0) {
    console.error(`${failures.length} of ${paths.length} sessions could not be read`);
    process.exitCode = 1;
  }
}

try { await main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
