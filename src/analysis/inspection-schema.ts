import type { FieldSpec, StreamSpec } from "./rows.js";
const f = (name: string, type: string, description: string): FieldSpec => ({ name, type, description });
const identity = [
  f("session", "string", "Recorded session ID; may be shared by multiple segments."),
  f("source", "string", "pi, claude, or codex."),
  f("segment", "string", "Absolute file actually parsed, including a stored raw snapshot when selected."),
  f("fingerprint", "string", "SHA-256 of exact raw segment bytes."),
  f("line", "number", "Raw source entry line; merged calls cite their own block entry."),
  f("byteStart", "number", "Raw source entry start byte."), f("byteEnd", "number", "Exclusive raw source entry end byte."),
  f("callId", "string|null", "Underlying call ID; null for message evidence."),
  f("ref", "string|null", "Snapshot-pinned reference for call --ref or message --ref, identified by refKind."),
  f("refKind", "string", "call or message."), f("messageRef", "string|null", "Enclosing message; open with message --ref for neighbors."),
  f("resultSource", "object|null", "Recorded result {line,byteStart,byteEnd,entryId?}; null when unfinished or not a call."),
];
const outcome = [f("outcome", "string", "succeeded, failed, or unfinished. Recorded call completion, never proof an effect happened or validation was adequate."),
  f("isError", "boolean|null", "Recorded error flag; null without result."), f("exitCode", "number|null", "Recorded/parsed exit code, where available. Nonzero is failed even if isError is false.")];
const contract = "Exploration contract only: pass --contract exploration. Legacy output remains the default and has different fields/meanings. Default 20 rows; filter before offset/limit. --page wraps rows with schemaVersion, matched, offset, returned, nextOffset, complete, selectedSources, readSources, failedSources, selectionMode, and snapshot. Complete means all selected segments read, not full history or all rows returned.";
export const FILES_SCHEMA: StreamSpec = { description: `${contract} One row per explicit file-tool target or inferred shell effect, including failed/unfinished attempts. No aggregation or unknown-effect reconstruction.`, fields: [
  ...identity, f("path", "string", "Target normalized relative to recorded cwd where inside it."), f("sourcePath", "string", "Literal target from normalized tool args or shell-effect parser; not necessarily raw provider syntax."),
  f("operation", "string", "read, write, edit, or mutation (shell mutation type unspecified)."), f("basis", "string", "explicit-file-tool or inferred-shell; both describe attempted targets."), f("via", "string", "Normalized tool name or shell syntax/program naming this effect."), ...outcome,
] };
export const COMMANDS_SCHEMA: StreamSpec = { description: `${contract} One normalized shell call, including attempts without results. Default command prefix 240 Unicode code points; expand using call --ref.`, fields: [
  ...identity, f("tool", "string", "Normalized tool name (bash)."), f("seq", "number", "Unfiltered call sequence within this segment."),
  f("command", "object", "TextSlice {text,offset,totalChars,nextOffset,truncated}. Bounded prefix, not full command."), f("commandBytes", "number", "Full command UTF-8 bytes."), f("commandHash", "string", "SHA-256 of full command text."),
  f("classes", "string[]", "Deterministic command classification, including project rules."), ...outcome, f("resultBytes", "number|null", "Full recorded result bytes, null without result."), f("opaque", "string[]", "Reasons shell effects may be unknown; empty does not prove no effects."),
] };
export const SKILLS_SCHEMA: StreamSpec = { description: `${contract} Invocations/spans: one row per expanded user skill or reconstructed SKILL.md load candidate. Attributions: one row per membership. Failed/unconfirmed loads remain visible but have no active span. Same-turn association is never proof of adherence.`, fields: [
  ...identity, f("sources", "object[]", "Raw source ranges supporting trigger/attribution; merged messages may have several."), f("view", "string", "invocations, spans, or attributions; spans retain the invocation fields."),
  f("id", "string", "Skill invocation identity, qualified by segment/fingerprint for uniqueness."), f("name", "string", "Parsed skill name; failed/unconfirmed reads retain path as name."), f("path", "string|null", "Recorded skill path."),
  f("mode", "string", "explicit-command or model-load-candidate."), f("confidence", "string", "observed expansion or reconstructed invocation candidate."), f("loadStatus", "string", "expanded, loaded, failed, or unconfirmed."),
  f("contentHash", "string", "Loaded content SHA-256; empty when unavailable."), f("contentBytes", "number", "Loaded content byte length; zero for unavailable content, consult loadStatus."), f("turn", "number", "Zero-based user-turn window; -1 before first user."),
  f("activeStartLine", "number|null", "First subsequent assistant entry in same turn after successful load; null when inactive."), f("activeEndLine", "number", "Last entry in same turn; bound does not imply adherence."), f("boundaryRule", "string", "explicit-command or same-agent-turn."),
  f("recordKind", "string|null", "Attribution target: message or tool-call; null in other views."), f("recordId", "string|null", "Attributed canonical record ID."), f("attributionBasis", "string|null", "explicit-skill-message, skill-load, or within-turn-window; null in other views."),
] };
export const INSPECTION_SCHEMAS = { files: FILES_SCHEMA, commands: COMMANDS_SCHEMA, skills: SKILLS_SCHEMA };

/** Shared enum values for executable options and library validation. */
export const INSPECTION_CHOICES = {
  operation: ["read", "write", "edit", "mutation"],
  basis: ["explicit-file-tool", "inferred-shell"],
  outcome: ["succeeded", "failed", "unfinished"],
  loadStatus: ["expanded", "loaded", "failed", "unconfirmed"],
  view: ["invocations", "spans", "attributions"],
} as const;
