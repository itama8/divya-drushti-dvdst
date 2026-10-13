import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isObject, readJsonl, type SourceRecord } from "../pi/read-jsonl.js";
import { collectCodexStage } from "./codex.js";

/** Load one same-session pagination chain, checking recorded ordinal/byte boundaries. */
export async function collectCodexFile(file: string) {
  const supplied = await readJsonl(file);
  const header = supplied[0]?.value;
  if (!isObject(header) || header.type !== "session_meta" || !isObject(header.payload)
    || typeof header.payload.id !== "string") throw new Error("invalid Codex session header");
  const id = header.payload.id;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("invalid Codex session identity");
  if (header.payload.history_mode !== "paginated") return collectCodexStage(supplied);
  const segments: SourceRecord[][] = [];
  let suppliedSeen = false;
  for (const name of await readdir(dirname(file))) {
    if (!name.startsWith("rollout-") || !name.endsWith(".jsonl") || !name.includes(id)) continue;
    const candidate = join(dirname(file), name);
    const records = resolve(candidate) === resolve(file) ? supplied : await readJsonl(candidate);
    const first = records[0]?.value;
    if (!isObject(first) || first.type !== "session_meta" || !isObject(first.payload)) throw new Error("invalid Codex pagination candidate");
    if (first.payload.id !== id) continue;
    if (resolve(candidate) === resolve(file)) suppliedSeen = true;
    segments.push(records);
  }
  // Explicit fixture/evidence filenames need not follow rollout naming.
  if (!suppliedSeen) segments.push(supplied);
  const ordinal = (record: SourceRecord | undefined): number => {
    if (!record || !isObject(record.value) || !Number.isSafeInteger(record.value.ordinal)
      || (record.value.ordinal as number) < 0) throw new Error("Codex pagination requires nonnegative record ordinals");
    return record.value.ordinal as number;
  };
  segments.sort((a, b) => ordinal(a[0]) - ordinal(b[0]));
  const combined: SourceRecord[] = [];
  for (let i = 0; i < segments.length; i++) {
    const records = segments[i]!;
    const first = records[0]!.value as Record<string, unknown>;
    const meta = first.payload as Record<string, unknown>;
    const start = ordinal(records[0]);
    if (meta.forked_from_id !== undefined || meta.history_mode !== "paginated") throw new Error("forked or mixed Codex pagination is unsupported");
    if (i === 0) {
      if (start !== 0 || meta.history_base !== undefined) throw new Error("missing Codex pagination root");
    } else {
      const base = meta.history_base;
      const previous = segments[i - 1]!;
      if (!isObject(base) || base.thread_id !== id || base.end_ordinal_exclusive !== start
        || !Number.isSafeInteger(base.end_byte_offset) || start <= ordinal(previous[0])) throw new Error("invalid or forked Codex pagination boundary");
      const boundary = previous.find(record => ordinal(record) === start - 1);
      if (!boundary || boundary.source.byteEnd !== base.end_byte_offset) throw new Error("Codex pagination byte/ordinal boundary does not match predecessor");
    }
    for (let n = 0; n < records.length; n++) {
      if (ordinal(records[n]) !== start + n) throw new Error("Codex pagination has an ordinal gap or duplicate");
    }
    const stop = i + 1 < segments.length ? ordinal(segments[i + 1]![0]) : Infinity;
    if (stop > start + records.length && stop !== Infinity) throw new Error("missing Codex pagination records");
    for (const record of records) {
      if (ordinal(record) >= stop) break;
      combined.push(record);
    }
  }
  return collectCodexStage(combined, true);
}
