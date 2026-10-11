import { isObject, readJsonl, type SourceRecord } from "../pi/read-jsonl.js";
import { claudeToCanonical, isClaudeEntry } from "./claude.js";

export type SessionSource = "pi" | "claude";

export function detectSource(records: SourceRecord[]): SessionSource {
  for (const record of records.slice(0, 50)) {
    if (isObject(record.value) && record.value.type === "session") return "pi";
    if (isClaudeEntry(record.value)) return "claude";
  }
  return "pi";
}

/**
 * Reads a session file from any supported agent and returns entries in the
 * one shape the rest of dvdst reads: a `session` header, then messages with
 * `toolCall` blocks and `toolResult` messages. A Pi session already has that
 * shape and is returned as read.
 */
export async function readSessionRecords(path: string): Promise<{ source: SessionSource; records: SourceRecord[]; lines: number }> {
  const raw = await readJsonl(path);
  const source = detectSource(raw);
  // `lines` counts the entries of the file itself, which a conversion may merge or drop.
  return { source, records: source === "claude" ? claudeToCanonical(raw) : raw, lines: raw.length };
}
