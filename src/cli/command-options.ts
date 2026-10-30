/** Executable parseArgs options and catalog metadata live together. */
interface Metadata {
  description: string;
  choices?: readonly string[];
  valueType?: "integer";
  minimum?: number;
  maximum?: number;
  effectiveDefault?: string | number | boolean;
  defaultDescription?: string;
  minLength?: number;
  const?: string | number | boolean;
}
function s<const T extends Record<string, unknown> = {}>(description: string, extra = {} as T) {
  return { type: "string" as const, description, ...extra };
}
function b<const T extends Record<string, unknown> = {}>(description: string, extra = {} as T) {
  return { type: "boolean" as const, description, ...extra };
}
export type CatalogOption = Metadata & { type: "string" | "boolean"; short?: string; default?: string | boolean };

/** Keep metadata out of Node's parseArgs implementation while preserving its types. */
export function parserOptions<const T extends Record<string, CatalogOption>>(options: T): { [K in keyof T]: Pick<T[K], Extract<keyof T[K], "type" | "short" | "default">> } {
  return Object.fromEntries(Object.entries(options).map(([name, option]) => [name, {
    type: option.type, ...(option.short === undefined ? {} : { short: option.short }),
    ...(option.default === undefined ? {} : { default: option.default }),
  }])) as { [K in keyof T]: Pick<T[K], Extract<keyof T[K], "type" | "short" | "default">> };
}

const help = b("Print command usage.", { short: "h" });
const selection = {
  root: s("Flat directory of JSONL files; overrides default discovery roots."),
  project: s("Constrain discovery to a project directory name/suffix."),
  last: s("Keep the newest N sessions, not N output rows.", { valueType: "integer", minimum: 1 }),
  since: s("Keep sessions started at/after a YYYY-MM-DD date or timestamp."),
  source: s("Source for discovery; exact transcript contents identify their source.", { choices: ["pi", "claude", "codex", "all"], defaultDescription: "DVDST_SOURCE, then pi. Exact files are autodetected." }),
};
const rows = {
  fields: s("Comma-separated output field names; consult the output schema."),
  limit: s("Maximum output rows across selected files after filtering.", { valueType: "integer", minimum: 1 }),
  offset: s("Skip matching rows across selected files; not a snapshot cursor.", { valueType: "integer", minimum: 0, effectiveDefault: 0 }),
};
const rowFormat = s("Output encoding.", { choices: ["jsonl", "json", "tsv"], effectiveDefault: "jsonl" });
const config = s("Project classification/finding rules file; otherwise use recorded cwd rules.");
const store = s("Evidence store directory.", { short: "s", defaultDescription: "Writer default: .dvdst/store; explicit store selection is required by some readers." });
const session = s("Exact session identity (store mode), not an analysis ID prefix.");
const snapshot = s("Exact stored source snapshot SHA-256.");
const role = s("Comma-separated user,assistant,toolResult,system,developer; or all.", { defaultDescription: "Message text: user,assistant. Command/result targets use assistant/toolResult unless explicitly filtered." });
const ref = s("Opaque exact-file reference; any raw file append/change makes it stale.");
const seq = s("1-based position within the selected segment.", { valueType: "integer", minimum: 1 });
const textLimit = s("Characters per text field (Unicode code points), not a total JSON byte budget.", { valueType: "integer", minimum: 1, maximum: 65536 });
const textOffset = s("Zero-based Unicode code-point offset.", { valueType: "integer", minimum: 0, effectiveDefault: 0 });

export const CLI_OPTIONS = {
  analysis: {
    ...selection, tool: s("Exact normalized tool name; calls only."), id: s("Exact call ID; calls only."), seq,
    class: s("Command classification; calls only."), ...rows,
    errors: b("Only calls with an explicitly failed result.", { default: false }),
    full: b("Add call arguments/result text and context section text; does not add turns text.", { default: false }),
    config, "no-cache": b("Bypass cached derived rows.", { default: false }),
    clear: b("Delete the derived row cache; cache command only.", { default: false }), format: rowFormat, help,
  },
  call: { id: s("Exact call ID; use seq if ambiguous."), seq, ref,
    limit: { ...textLimit, effectiveDefault: 4096 }, "args-offset": textOffset, "result-offset": textOffset, "command-offset": textOffset, help },
  conversation: {
    ...selection, role, query: s("Nonempty literal search string, not a user regex.", { minLength: 1 }),
    in: s("Search target.", { choices: ["messages", "commands", "results", "all"], effectiveDefault: "messages" }),
    "ignore-case": b("Use Unicode simple case folding for literal search."), ...rows,
    "text-limit": s("Characters per returned prefix/excerpt.", { valueType: "integer", minimum: 1, maximum: 4096, effectiveDefault: 240 }),
    format: rowFormat, page: b("Return JSON counts, nextOffset, completeness, and failed sources; implies JSON format."),
    ref, seq, before: s("Canonical messages before the anchor.", { valueType: "integer", minimum: 0, maximum: 10, effectiveDefault: 2 }),
    after: s("Canonical messages after the anchor.", { valueType: "integer", minimum: 0, maximum: 10, effectiveDefault: 2 }),
    "text-offset": textOffset, help,
  },
  records: { path: s("File path substring; files only."), class: s("Command classification; commands only."),
    view: s("Skill view in store mode.", { default: "invocations", choices: ["invocations", "spans", "attributions"] }),
    store, session, snapshot, format: s("Output encoding.", { default: "tsv", choices: ["json", "tsv"] }), help },
  trace: { id: s("Call, canonical record, skill invocation ID, or file path.", { short: "i" }), format: s("Output encoding.", { default: "text", choices: ["json", "tsv", "text"] }), help },
  handoff: { session: s("Alternative to one positional session selector.", { short: "s" }), devlog: s("Optional devlog for comparison.", { short: "d" }), format: s("Output encoding.", { default: "text", choices: ["text", "json"] }), help },
  handoffDevlog: {
    session: s("Alternative to one positional session selector.", { short: "s" }), devlog: s("Optional devlog for comparison.", { short: "d" }), out: s("Write generated devlog to this path instead of stdout.", { short: "o" }),
    project: s("Project name in generated frontmatter.", { default: "omakase-v2" }), phase: s("Generated phase.", { default: "docs-spine" }),
    checkpoint: s("Generated checkpoint.", { default: "auto-derived" }), focus: s("Generated focus.", { default: "Auto-derived handoff bundle" }),
    date: s("Generated date.", { default: new Date().toISOString().slice(0, 10), defaultDescription: "Current UTC date." }),
    "session-num": s("Generated session number.", { default: "1" }), help,
  },
  probe: { session: s("Alternative to one positional session selector.", { short: "s" }), devlog: s("Optional devlog for comparison.", { short: "d" }), out: s("Existing directory for bundle and evidence files.", { short: "o" }), pretty: b("Pretty-print JSON.", { default: false }), help },
  sessions: { format: s("Output encoding.", { default: "tsv", choices: ["json", "jsonl", "tsv"] }), limit: s("Limit discovered filenames.", { valueType: "integer", minimum: 1 }), help },
  stage: { input: s("Recorded live event stream.", { short: "i" }), "session-file": s("Transcript file."), manifest: s("HEAD-pinned selection manifest."), cwd: s("Target repository directory."), session: s("Caller session identity."), after: s("Verified mutation-result cursor."), "dry-run": b("Compute report without publishing the index."), help },
  sessionStage: { agent: s("Transcript agent.", { choices: ["claude", "codex"] }), session: s("Caller/session identity."), "session-file": s("Exact transcript file."), repository: s("Target repository directory."), manifest: s("HEAD-pinned selection manifest."), after: s("Verified mutation-result cursor."), "dry-run": b("Compute report without publishing the index."), list: b("List supported successful mutation selectors without staging."), help },
  live: { input: s("Canonical producer event JSONL; otherwise stdin.", { short: "i" }), help },
  review: { input: s("Recorded live event stream.", { short: "i" }), watch: b("Watch for more recorded events.", { short: "w" }), "interval-ms": s("Polling interval in milliseconds.", { default: "1000", valueType: "integer", minimum: 100 }), help },
  ingest: { live: s("Ingest one canonical live event stream instead of transcripts."), store, help },
  normalize: { store, session, snapshot, help },
  artifacts: { store, session, snapshot, config, help },
  events: { store, session, snapshot, config, help },
  timeline: { store, source: s("Stored live producer namespace, not transcript --source discovery."), session, snapshot, kind: s("Event kind filter.", { short: "k" }), help },
  export: { input: s("Observed evidence JSONL; otherwise stdin.", { short: "i" }), store, source: s("Stored live producer namespace."), session, snapshot, format: s("Rendered output.", { short: "f", choices: ["markdown", "csv"] }), help },
  cleanup: { store, yes: b("Explicitly remove a marked local evidence store.", { short: "y", const: true }), help },
  capabilities: { format: s("Catalog output encoding.", { choices: ["json", "text"], effectiveDefault: "json" }), group: s("Filter the compact catalog by command group.", { choices: ["exploration", "inspection", "storage", "live", "staging", "utility"] }), help },
} as const;

export const CONVERSATION_ALLOWED = {
  message: ["ref", "seq", "before", "after", "limit", "text-offset", "format", "help"],
  messages: ["source", "project", "root", "last", "since", "role", "limit", "offset", "text-limit", "fields", "format", "page", "help"],
  search: ["source", "project", "root", "last", "since", "role", "limit", "offset", "text-limit", "fields", "format", "page", "query", "in", "ignore-case", "help"],
} as const;

export function pickOptions(options: Record<string, CatalogOption>, names: readonly string[]): Record<string, CatalogOption> {
  return Object.fromEntries(names.map(name => {
    if (!Object.hasOwn(options, name)) throw new Error(`Missing shared option ${name}`);
    return [name, options[name]!];
  }));
}
