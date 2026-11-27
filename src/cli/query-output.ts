import type { StreamSpec } from "../analysis/rows.js";
import type { EvidencePage } from "../analysis/conversation.js";

export function queryFields(schema: StreamSpec, value?: string): string[] {
  const fields = value?.split(",") ?? schema.fields.map(field => field.name);
  if (new Set(fields).size !== fields.length || fields.some(name => !schema.fields.some(field => field.name === name))) throw new Error("Invalid or duplicate --fields. Consult schema for this command.");
  return fields;
}
export function queryFormat(format: string | undefined, page: boolean): string {
  const selected = format ?? (page ? "json" : "jsonl");
  if (!["jsonl", "json", "tsv"].includes(selected)) throw new Error("--format must be jsonl, json, or tsv.");
  if (page && selected !== "json") throw new Error("--page requires JSON output; omit --format or use --format json.");
  return selected;
}
/** Stderr notice for an --offset at or past the matched rows; stdout stays pure data. */
export function offsetNotice(offset: number, matched: number): string {
  return `dvdst: --offset ${offset} is at or past the ${matched} matching row(s); no rows returned. Use a smaller --offset, or --page for counts.`;
}

const cell = (value: unknown) => (value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value)).replace(/[\t\n\r]/g, " ");

/** Shared global pagination/projection and partial-source contract for evidence queries. */
export async function emitQuery(options: {
  paths: string[]; fields: string[]; format: string; page: boolean; offset: number; limit: number;
  metadata?: Record<string, unknown>;
  read: (path: string, offset: number, limit: number) => Promise<EvidencePage<unknown>>;
}) {
  const { paths, fields, format, offset, limit } = options;
  const rows: Array<Record<string, unknown>> = [];
  const failures: Array<{ path: string; error: string }> = [];
  let skip = offset;
  let returned = 0;
  let matched = 0;
  if (format === "tsv") process.stdout.write(`${fields.join("\t")}\n`);
  for (const path of paths) {
    try {
      const page = await options.read(path, skip, Math.max(1, limit - returned));
      matched += page.matched;
      skip -= Math.min(skip, page.matched);
      const selected = returned < limit ? page.rows : [];
      returned += selected.length;
      for (const item of selected) {
        const row = Object.fromEntries(fields.map(name => [name, (item as Record<string, unknown>)[name] ?? null]));
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
  if (format === "json") process.stdout.write(`${JSON.stringify(options.page ? {
    schemaVersion: 1, ...options.metadata, rows, matched, offset, returned, nextOffset: offset + returned < matched ? offset + returned : null,
    complete: failures.length === 0, selectedSources: paths.length, readSources: paths.length - failures.length, failedSources: failures,
  } : rows)}\n`);
  // The --page envelope already carries matched, offset, and returned.
  if (!options.page && offset > 0 && offset >= matched) console.error(offsetNotice(offset, matched));
  if (failures.length > 0) {
    console.error(`${failures.length} of ${paths.length} sessions could not be read`);
    process.exitCode = 1;
  }
}
