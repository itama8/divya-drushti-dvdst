import { decodeCallReference } from "./call-reference.js";
import { loadSession, loadSessionFile } from "./session.js";
import type { Row, StreamSpec } from "./rows.js";
import { resolve } from "node:path";

export const CALL_SCHEMA: StreamSpec = {
  description: "One exact tool call with independently bounded command, serialized arguments, and result text.",
  fields: [
    { name: "schemaVersion", type: "number", description: "1." },
    { name: "source", type: "string", description: "pi, claude, or codex." },
    { name: "path", type: "string", description: "Exact segment file." },
    { name: "fingerprint", type: "string", description: "SHA-256 of the raw file bytes read." },
    { name: "call", type: "object", description: "calls row metadata, including ref; excludes command, args and resultText." },
    ...["command", "args", "result"].map(name => ({ name, type: name === "args" ? "object" : "object|null", description: "Text slice: {text, offset, totalChars, nextOffset, truncated}. Unicode code-point offsets; null when absent. args is serialized JSON." })),
  ],
};

export interface TextSlice {
  text: string;
  offset: number;
  totalChars: number;
  nextOffset: number | null;
  truncated: boolean;
}

export function sliceText(text: string, offset = 0, limit = 4096): TextSlice {
  integerOption(offset, "offset", 0);
  integerOption(limit, "limit", 1, 65536);
  const chars = Array.from(text);
  if (offset > chars.length) throw new Error(`Offset ${offset} exceeds text length ${chars.length}.`);
  const end = Math.min(chars.length, offset + limit);
  return { text: chars.slice(offset, end).join(""), offset, totalChars: chars.length, nextOffset: end < chars.length ? end : null, truncated: offset > 0 || end < chars.length };
}

export function integerOption(value: string | number | undefined, name: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === "string" && !/^\d+$/.test(value) ? NaN : Number(value);
  if (!Number.isSafeInteger(n) || n < minimum || n > maximum) throw new Error(`${name} must be a whole number from ${minimum} to ${maximum}.`);
  return n;
}

export interface ReadCallOptions {
  session?: string;
  id?: string;
  seq?: number;
  ref?: string;
  limit?: number;
  argsOffset?: number;
  resultOffset?: number;
  commandOffset?: number;
}

/** Reads any tool, including opaque/unsupported tools, without inferring effects. */
export async function readCall(options: ReadCallOptions) {
  const reference = options.ref === undefined ? undefined : decodeCallReference(options.ref);
  if (reference !== undefined && (options.session !== undefined || options.id !== undefined || options.seq !== undefined)) throw new Error("Use --ref alone, or a session with exactly one of --id / --seq.");
  if (reference === undefined && (options.session === undefined || (options.id === undefined) === (options.seq === undefined))) throw new Error("Provide --ref, or a session with exactly one of --id / --seq.");
  const limit = integerOption(options.limit ?? 4096, "--limit", 1, 65536)!;
  const argsOffset = integerOption(options.argsOffset ?? 0, "--args-offset", 0)!;
  const resultOffset = integerOption(options.resultOffset ?? 0, "--result-offset", 0)!;
  const commandOffset = integerOption(options.commandOffset ?? 0, "--command-offset", 0)!;
  if (options.seq !== undefined) integerOption(options.seq, "--seq", 1);
  const session = reference === undefined ? await loadSession(options.session, { full: true }) : await loadSessionFile(reference.path, { full: true });
  if (reference !== undefined && reference.fingerprint !== session.fingerprint) throw new Error("Stale call reference: the file changed. Refresh dvdst calls for this exact segment and use its new ref.");
  const matches = session.calls.filter(row => reference !== undefined
    ? row.callId === reference.callId && row.line === reference.line
    : options.id !== undefined ? row.callId === options.id : row.seq === options.seq);
  if (matches.length !== 1) throw new Error(matches.length === 0 ? "Call not found in the selected segment." : "Ambiguous call ID; use --seq for this segment.");
  const { command, args, resultText, ...call } = matches[0]!;
  return {
    schemaVersion: 1,
    source: session.source,
    path: resolve(session.path),
    fingerprint: session.fingerprint,
    call: call as Row,
    command: typeof command === "string" ? sliceText(command, commandOffset, limit) : null,
    args: sliceText(JSON.stringify(args), argsOffset, limit),
    result: typeof resultText === "string" ? sliceText(resultText, resultOffset, limit) : null,
  };
}
