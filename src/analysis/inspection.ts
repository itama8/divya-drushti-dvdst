import { INSPECTION_CHOICES } from "./inspection-schema.js";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { conversationFromSession, type EvidencePage } from "./conversation.js";
import { integerOption, sliceText } from "./read-call.js";
import type { SessionData } from "./session.js";
import type { Row } from "./rows.js";
import type { SourceReference } from "../pi/read-jsonl.js";
import { parseBashEffects } from "../pi/bash-effects.js";
import { normalizeSessionPath } from "../pi/normalize-paths.js";
import { deriveSkillEvidence } from "../skills/extract.js";

export type InspectionKind = "files" | "commands" | "skills";
export interface InspectionQueryOptions {
  offset?: number;
  limit?: number;
  textLimit?: number;
  path?: string;
  class?: string;
  name?: string;
  operation?: "read" | "write" | "edit" | "mutation";
  basis?: "explicit-file-tool" | "inferred-shell";
  outcome?: "succeeded" | "failed" | "unfinished";
  loadStatus?: "expanded" | "loaded" | "failed" | "unconfirmed";
  view?: "invocations" | "spans" | "attributions";
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const outcome = (call: Row) => call.resultLine === null ? "unfinished" : call.isError === true || typeof call.exitCode === "number" && call.exitCode !== 0 ? "failed" : "succeeded";

/** Validate before source selection so invalid filters never look like an empty query. */
export function validateInspectionOptions(kind: InspectionKind, options: InspectionQueryOptions): void {
  if (!["files", "commands", "skills"].includes(kind)) throw new Error("Expected files, commands, or skills.");
  integerOption(options.offset ?? 0, "--offset", 0);
  integerOption(options.limit ?? 20, "--limit", 1);
  integerOption(options.textLimit ?? 240, "--text-limit", 1, 4096);
  for (const [key, allowed] of Object.entries(INSPECTION_CHOICES)) {
    const value = options[key as keyof InspectionQueryOptions];
    if (value !== undefined && !(allowed as readonly string[]).includes(String(value))) throw new Error(`Invalid ${key}: ${value}; choose ${allowed.join(", ")}.`);
  }
  const allowed = kind === "files" ? ["path", "operation", "basis", "outcome"] : kind === "commands" ? ["class", "outcome"] : ["name", "loadStatus", "view"];
  for (const key of Object.keys(options)) if (!["offset", "limit", "textLimit", ...allowed].includes(key)) throw new Error(`${key} does not apply to ${kind}.`);
}

/** Query one exact, fully loaded segment. Filtering precedes pagination. No store writes. */
export function queryInspection(session: SessionData, kind: InspectionKind, options: InspectionQueryOptions = {}): EvidencePage<Row> {
  validateInspectionOptions(kind, options);
  if (session.calls.some(call => call.args === undefined)) throw new Error("Inspection requires full SessionData; load with {full:true}.");
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 20;
  const textLimit = options.textLimit ?? 240;
  const conversation = conversationFromSession(session);
  const identity = { session: session.session, source: session.source, segment: resolve(session.path), fingerprint: session.fingerprint };
  const callEntries = conversation.messages.flatMap(message => message.calls.map(call => ({ ...call, message })));
  const locate = (source: SourceReference, call?: Row, messageRef?: string) => ({
    ...identity, line: source.line, byteStart: source.byteStart, byteEnd: source.byteEnd,
    callId: call?.callId ?? null, ref: call?.ref ?? messageRef ?? null, refKind: call ? "call" : "message",
    messageRef: messageRef ?? null,
    resultSource: call?.resultLine == null ? null : session.records.find(record => record.source.line === call.resultLine)?.source ?? null,
  });
  let rows: Row[];
  if (kind === "commands") {
    rows = callEntries.filter(({ row }) => typeof row.command === "string").map(({ row, source, message }) => ({
      ...locate(source, row, message.metadata.ref), tool: row.tool, seq: row.seq,
      command: sliceText(row.command as string, 0, textLimit), commandBytes: Buffer.byteLength(row.command as string), commandHash: hash(row.command as string),
      classes: row.classes, outcome: outcome(row), isError: row.isError, exitCode: row.exitCode, resultBytes: row.resultBytes, opaque: row.opaque,
    })).filter(row => (options.class === undefined || (row.classes as string[]).includes(options.class)) && (options.outcome === undefined || row.outcome === options.outcome));
  } else if (kind === "files") {
    rows = callEntries.flatMap(({ row, source, message }) => {
      const args = row.args as Record<string, unknown>;
      const effects = typeof row.command === "string" ? parseBashEffects(row.command).effects.map(effect => ({ path: effect.path, operation: effect.effect === "read" ? "read" : "mutation", basis: "inferred-shell", via: effect.via }))
        : ["read", "edit", "write"].includes(String(row.tool)) && typeof args.path === "string" ? [{ path: args.path, operation: row.tool, basis: "explicit-file-tool", via: row.tool }]
        : row.tool === "apply_patch" && Array.isArray(args.paths) ? args.paths.filter((path): path is string => typeof path === "string").map(path => ({ path, operation: "edit", basis: "explicit-file-tool", via: "apply_patch" })) : [];
      return effects.map(effect => ({ ...locate(source, row, message.metadata.ref), path: normalizeSessionPath(effect.path, session.cwd), sourcePath: effect.path,
        operation: effect.operation, basis: effect.basis, via: effect.via, outcome: outcome(row), isError: row.isError, exitCode: row.exitCode }));
    }).filter(row => (options.path === undefined || row.path.includes(options.path)) && (options.operation === undefined || row.operation === options.operation)
      && (options.basis === undefined || row.basis === options.basis) && (options.outcome === undefined || row.outcome === options.outcome));
  } else {
    // Reuse the stored skill algorithm without creating normalized files or artifacts.
    const messages = conversation.messages.map(message => ({ schemaVersion: 1, entryId: message.metadata.id ?? `message:${message.metadata.seq}`, role: message.metadata.role, text: message.text,
      source: { ...(message.metadata.id === null ? {} : { entryId: message.metadata.id }), line: message.metadata.line, byteStart: message.metadata.byteStart, byteEnd: message.metadata.byteEnd } }));
    const calls = callEntries.map(({ row, source, message }) => ({ schemaVersion: 1, toolCallId: row.callId as string, name: row.tool as string, arguments: row.args as Record<string, unknown>, entryId: message.metadata.id!, source }));
    // Use the canonical call/result join, including Codex polling completion, rather than inventing empty results.
    const results = callEntries.filter(({ row }) => row.resultLine !== null).map(({ row }) => ({ schemaVersion: 1, toolCallId: row.callId as string, toolName: row.tool as string,
      isError: outcome(row) === "failed", text: row.resultText as string, entryId: `result:${row.resultLine}`, source: session.records.find(record => record.source.line === row.resultLine)!.source }));
    const evidence = deriveSkillEvidence(messages, calls, results, session.session);
    const view = options.view ?? "invocations";
    const seeds = evidence.invocationLines.filter(seed => (options.name === undefined || seed.name.includes(options.name)) && (options.loadStatus === undefined || seed.loadStatus === options.loadStatus));
    rows = seeds.flatMap(seed => {
      const locations = view === "attributions" ? evidence.attributedRecords.flatMap(record => record.labels.filter(label => label.invocationId === seed.id).map(label => ({ source: record.source as SourceReference, recordKind: record.recordKind, recordId: record.recordId, attributionBasis: label.basis })))
        : [{ source: seed.trigger, recordKind: null, recordId: null, attributionBasis: null }];
      return locations.map(location => {
        const call = callEntries.find(item => item.source.line === location.source.line && (location.recordKind === "tool-call" ? item.row.callId === location.recordId : item.row.tool === "read" && (item.row.args as Record<string, unknown>).path === seed.path));
        const message = conversation.messages.find(item => item.metadata.line === location.source.line || item.metadata.sources.some(source => source.line === location.source.line));
        const base = locate(location.source, location.recordKind === "message" ? undefined : call?.row, message?.metadata.ref);
        return { ...base, sources: location.recordKind === "message" || seed.mode === "explicit-command" && view !== "attributions" ? message?.metadata.sources ?? [location.source] : [location.source],
          view, id: seed.id, name: seed.name, path: seed.path ?? null, mode: seed.mode, confidence: seed.confidence, loadStatus: seed.loadStatus,
          contentHash: seed.contentHash, contentBytes: seed.contentBytes, turn: seed.turn, activeStartLine: seed.activeStartLine, activeEndLine: seed.activeEndLine, boundaryRule: seed.boundaryRule,
          recordKind: location.recordKind, recordId: location.recordId, attributionBasis: location.attributionBasis };
      });
    });
  }
  return { rows: rows.slice(offset, offset + limit), matched: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null };
}
