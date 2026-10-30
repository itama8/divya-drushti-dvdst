import { resolve } from "node:path";
import { isObject, type SourceReference } from "../pi/read-jsonl.js";
import { decodeMessageReference, encodeMessageReference } from "./message-reference.js";
import { decodeCallReference } from "./call-reference.js";
import { integerOption, sliceText, type TextSlice } from "./read-call.js";
import { loadSession, loadSessionFile, type SessionData } from "./session.js";
import type { Row } from "./rows.js";

const ROLES = ["user", "assistant", "toolResult", "system", "developer"] as const;
export type RoleSelection = readonly string[] | "all";
export type SearchScope = "messages" | "commands" | "results" | "all";

export function validateRoles(roles: RoleSelection | undefined): void {
  if (roles === undefined || roles === "all") return;
  if (roles.length === 0 || new Set(roles).size !== roles.length || roles.some(role => !ROLES.includes(role as typeof ROLES[number]))) {
    throw new Error("--role must be all or comma-separated user,assistant,toolResult,system,developer (without duplicates).");
  }
}

export interface MessageMetadata {
  session: string;
  source: string;
  path: string;
  seq: number;
  id: string | null;
  role: string;
  channel: string | null;
  line: number;
  byteStart: number;
  byteEnd: number;
  sources: SourceReference[];
  turn: number | null;
  userTurn: number;
  callIds: string[];
  callRefs: string[];
  resultCallId: string | null;
  resultCallRef: string | null;
  ref: string;
}

export interface MessageRow extends MessageMetadata { text: TextSlice }
interface TextPart { offset: number; chars: number; source: SourceReference }
export interface ConversationMessage { metadata: MessageMetadata; text: string; parts: TextPart[]; calls: Array<{ row: Row; source: SourceReference }> }
export interface Conversation { session: SessionData; messages: ConversationMessage[] }

function uniqueSources(sources: SourceReference[]): SourceReference[] {
  return [...new Map(sources.map(source => [JSON.stringify(source), source])).values()];
}

/** Text blocks only: never substitutes thinking blocks, image payloads, or tool arguments. */
function messageText(message: Record<string, unknown>, fallback: SourceReference, source: string) {
  const content = typeof message.content === "string" ? [{ type: "text", text: message.content }]
    : Array.isArray(message.content) ? message.content.filter(isObject) : [];
  if (content.length === 0 && isObject(message.sections)) {
    for (const value of Object.values(message.sections)) if (typeof value === "string") content.push({ type: "text", text: value });
  }
  const parts: TextPart[] = [];
  const texts: string[] = [];
  let offset = 0;
  for (const block of content) {
    if (block.type !== "text" || typeof block.text !== "string") continue;
    if (texts.length > 0) offset += 1; // The joining newline is a rendering separator.
    const provenance = source === "claude" && isObject(block.source) ? block.source as unknown as SourceReference : fallback;
    const chars = Array.from(block.text).length;
    parts.push({ offset, chars, source: provenance });
    texts.push(block.text);
    offset += chars;
  }
  return { text: texts.join("\n"), parts };
}

export function conversationFromSession(session: SessionData): Conversation {
  const messages: ConversationMessage[] = [];
  const callsByTurn = new Map<number, Row[]>();
  const resultsByLocation = new Map<string, Row[]>();
  for (const call of session.calls) {
    const turn = call.turn as number;
    callsByTurn.set(turn, [...(callsByTurn.get(turn) ?? []), call]);
    const key = JSON.stringify([call.callId, call.resultLine]);
    resultsByLocation.set(key, [...(resultsByLocation.get(key) ?? []), call]);
  }
  let turn = 0;
  let userTurn = 0;
  for (const record of session.records) {
    const entry = record.value;
    if (!isObject(entry) || !isObject(entry.message) || typeof entry.message.role !== "string") continue;
    const message = entry.message;
    const role = message.role as string;
    if (role === "user") userTurn += 1;
    if (role === "assistant") turn += 1;
    const seq = messages.length + 1;
    const id = typeof entry.id === "string" ? entry.id : null;
    const { text, parts } = messageText(message, record.source, session.source);
    const calls = role === "assistant" ? callsByTurn.get(turn) ?? [] : [];
    const content = Array.isArray(message.content) ? message.content.filter(isObject) : [];
    const callEvidence = calls.map(row => {
      const block = content.find(block => block.type === "toolCall" && block.id === row.callId);
      return { row, source: session.source === "claude" && isObject(block?.source) ? block.source as unknown as SourceReference : record.source };
    });
    const resultCallId = typeof message.toolCallId === "string" ? message.toolCallId : null;
    const results = resultCallId === null ? [] : resultsByLocation.get(JSON.stringify([resultCallId, record.source.line])) ?? [];
    const ref = encodeMessageReference({ v: 1, path: resolve(session.path), fingerprint: session.fingerprint, seq, line: record.source.line, id });
    messages.push({ text, parts, calls: callEvidence, metadata: {
      session: session.session, source: session.source, path: resolve(session.path), seq, id, role, channel: typeof message.channel === "string" ? message.channel : null,
      line: record.source.line, byteStart: record.source.byteStart, byteEnd: record.source.byteEnd,
      sources: uniqueSources([record.source, ...parts.map(part => part.source), ...callEvidence.map(call => call.source)]),
      turn: role === "assistant" ? turn : null, userTurn,
      callIds: calls.map(call => call.callId as string), callRefs: calls.map(call => call.ref as string),
      resultCallId, resultCallRef: results.length === 1 ? results[0]!.ref as string : null, ref,
    } });
  }
  return { session, messages };
}

export async function loadConversation(spec: string): Promise<Conversation> {
  return conversationFromSession(await loadSession(spec, { full: true }));
}

export interface ConversationQueryOptions {
  roles?: RoleSelection;
  offset?: number;
  limit?: number;
  textLimit?: number;
}
export interface EvidencePage<T> { rows: T[]; matched: number; nextOffset: number | null }

function queryOptions(options: ConversationQueryOptions) {
  validateRoles(options.roles);
  return {
    offset: integerOption(options.offset ?? 0, "--offset", 0)!,
    limit: integerOption(options.limit ?? 20, "--limit", 1)!,
    textLimit: integerOption(options.textLimit ?? 240, "--text-limit", 1, 4096)!,
  };
}

function roleMatches(role: string, roles: RoleSelection | undefined, defaults: readonly string[]) {
  return roles === "all" || (roles ?? defaults).includes(role);
}

export function listMessages(conversation: Conversation, options: ConversationQueryOptions = {}): EvidencePage<MessageRow> {
  const { offset, limit, textLimit } = queryOptions(options);
  const matching = conversation.messages.filter(message => roleMatches(message.metadata.role, options.roles, ["user", "assistant"]));
  const rows = matching.slice(offset, offset + limit).map(message => ({ ...message.metadata, text: sliceText(message.text, 0, textLimit) }));
  return { rows, matched: matching.length, nextOffset: offset + rows.length < matching.length ? offset + rows.length : null };
}

export interface SearchOptions extends ConversationQueryOptions {
  query: string;
  scope?: SearchScope;
  ignoreCase?: boolean;
}

export interface SearchHit {
  session: string;
  source: string;
  path: string;
  kind: "message" | "command" | "result";
  role: string;
  channel: string | null;
  line: number;
  sources: SourceReference[];
  messageSeq: number;
  messageRef: string;
  callId: string | null;
  ref: string;
  refKind: "message" | "call";
  match: { offset: number; chars: number };
  excerpt: TextSlice;
}

/** One hit per message/command/result, at its first literal match. */
export function searchConversation(conversation: Conversation, options: SearchOptions): EvidencePage<SearchHit> {
  const { offset, limit, textLimit } = queryOptions(options);
  if (options.query.length === 0) throw new Error("--query must not be empty.");
  const scope = options.scope ?? "messages";
  if (!["messages", "commands", "results", "all"].includes(scope)) throw new Error("--in must be messages, commands, results, or all.");
  // Escape the query so metacharacters remain literal. /iu provides Unicode
  // simple case folding without changing offsets by lowercasing the corpus.
  const matcher = options.ignoreCase ? new RegExp(options.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu") : undefined;
  const rows: SearchHit[] = [];
  let matched = 0;
  const add = (text: string, message: ConversationMessage, kind: SearchHit["kind"], ref: string, callId: string | null, parts = message.parts) => {
    const found = matcher?.exec(text);
    const index = matcher === undefined ? text.indexOf(options.query) : found?.index ?? -1;
    if (index < 0) return;
    matched += 1;
    if (matched <= offset || rows.length >= limit) return;
    const start = Array.from(text.slice(0, index)).length;
    const chars = Array.from(found?.[0] ?? options.query).length;
    const sources = uniqueSources(parts.filter(part => part.offset < start + chars && part.offset + part.chars > start).map(part => part.source));
    const provenance = sources.length > 0 ? sources : message.metadata.sources;
    rows.push({ session: conversation.session.session, source: conversation.session.source, path: resolve(conversation.session.path),
      kind, role: message.metadata.role, channel: message.metadata.channel, line: provenance[0]?.line ?? message.metadata.line, sources: provenance,
      messageSeq: message.metadata.seq, messageRef: message.metadata.ref, callId, ref, refKind: ref.startsWith("dvdst-call:") ? "call" : "message",
      match: { offset: start, chars }, excerpt: sliceText(text, Math.max(0, start - Math.floor(textLimit / 4)), textLimit),
    });
  };
  for (const message of conversation.messages) {
    const meta = message.metadata;
    if ((scope === "messages" || scope === "all") && !(scope === "all" && meta.role === "toolResult")
      && roleMatches(meta.role, options.roles, ["user", "assistant"])) add(message.text, message, "message", meta.ref, null);
    if ((scope === "commands" || scope === "all") && meta.role === "assistant" && roleMatches(meta.role, options.roles, ["assistant"])) {
      for (const { row: call, source } of message.calls) {
        if (typeof call.command !== "string") continue;
        add(call.command, message, "command", call.ref as string, call.callId as string, [{ offset: 0, chars: Array.from(call.command).length, source }]);
      }
    }
    if ((scope === "results" || scope === "all") && meta.role === "toolResult" && roleMatches(meta.role, options.roles, ["toolResult"])) {
      // Orphan results remain searchable; only attach a call ref when joined.
      add(message.text, message, "result", meta.resultCallRef ?? meta.ref, meta.resultCallId);
    }
  }
  return { rows, matched, nextOffset: offset + rows.length < matched ? offset + rows.length : null };
}

export interface ReadMessageOptions {
  session?: string;
  seq?: number;
  ref?: string;
  before?: number;
  after?: number;
  limit?: number;
  textOffset?: number;
}

export async function readMessage(options: ReadMessageOptions) {
  const callReference = options.ref?.startsWith("dvdst-call:") ? decodeCallReference(options.ref) : undefined;
  const messageReference = options.ref === undefined || callReference !== undefined ? undefined : decodeMessageReference(options.ref);
  const reference = callReference ?? messageReference;
  if (reference !== undefined && (options.session !== undefined || options.seq !== undefined)) throw new Error("Use --ref alone, or a session with --seq.");
  if (reference === undefined && (options.session === undefined || options.seq === undefined)) throw new Error("Provide --ref, or a session with --seq.");
  const requestedSeq = integerOption(messageReference?.seq ?? options.seq, "--seq", 1);
  const before = integerOption(options.before ?? 2, "--before", 0, 10)!;
  const after = integerOption(options.after ?? 2, "--after", 0, 10)!;
  const limit = integerOption(options.limit ?? 2000, "--limit", 1, 65536)!;
  const textOffset = integerOption(options.textOffset ?? 0, "--text-offset", 0)!;
  const session = reference === undefined ? await loadSession(options.session, { full: true }) : await loadSessionFile(reference.path, { full: true });
  if (reference !== undefined && reference.fingerprint !== session.fingerprint) throw new Error(`Stale ${callReference === undefined ? "message" : "call"} reference: the file changed. Refresh discovery for this exact segment.`);
  const conversation = conversationFromSession(session);
  let seq = requestedSeq;
  if (callReference !== undefined) {
    const calls = session.calls.filter(call => call.callId === callReference.callId && call.line === callReference.line);
    if (calls.length !== 1) throw new Error("Call not found or ambiguous in the selected segment.");
    seq = conversation.messages.find(message => message.metadata.role === "assistant" && message.metadata.turn === calls[0]!.turn)?.metadata.seq;
  }
  if (seq === undefined) throw new Error("Message not found in the selected segment.");
  const anchor = conversation.messages[seq - 1];
  if (anchor === undefined || (messageReference !== undefined && (anchor.metadata.line !== messageReference.line || anchor.metadata.id !== messageReference.id))) throw new Error("Message not found in the selected segment.");
  const start = Math.max(0, seq - 1 - before);
  const end = Math.min(conversation.messages.length, seq + after);
  return {
    schemaVersion: 1, source: session.source, session: session.session, path: resolve(session.path), fingerprint: session.fingerprint, anchorSeq: seq,
    messages: conversation.messages.slice(start, end).map(message => ({ ...message.metadata, text: sliceText(message.text, message === anchor ? textOffset : 0, limit) })),
    beforeRef: conversation.messages[start - 1]?.metadata.ref ?? null,
    afterRef: conversation.messages[end]?.metadata.ref ?? null,
  };
}
