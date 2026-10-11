import { basename, relative, resolve } from "node:path";
import { parseBashEffects } from "../pi/bash-effects.js";
import { classifyCommand, type CommandClassRule } from "../pi/classify-commands.js";
import { isObject, type SourceRecord } from "../pi/read-jsonl.js";
import { sessionIdFromFilename } from "../pi/sessions.js";

export const ROWS_SCHEMA_VERSION = 1;

export type StreamName = "overview" | "turns" | "calls" | "context";

export interface FieldSpec {
  name: string;
  type: string;
  description: string;
}

export interface StreamSpec {
  description: string;
  fields: FieldSpec[];
}

function field(name: string, type: string, description: string): FieldSpec {
  return { name, type, description };
}

const SESSION_FIELD = field("session", "string", "Session id from the session header. Present on every row, so rows from many sessions can share one file.");

/**
 * The row contract. `dvdst schema` prints it and the tests check every emitted
 * key against it, so a field cannot appear or change without this table.
 */
export const STREAMS: Record<StreamName, StreamSpec> = {
  overview: {
    description: "One row per session: size, time, tokens, cost, and tool totals.",
    fields: [
      SESSION_FIELD,
      field("source", "string", "Agent that wrote the session: pi or claude."),
      field("path", "string", "Session file the row was read from."),
      field("cwd", "string|null", "Working directory recorded in the session header."),
      field("startedAt", "string|null", "Timestamp of the session header."),
      field("endedAt", "string|null", "Timestamp of the last entry."),
      field("wallMs", "number|null", "endedAt minus startedAt. Includes time the session sat idle."),
      field("lines", "number", "Entries in the session file."),
      field("models", "string[]", "Distinct models that produced an assistant message, in first-use order."),
      field("firstPrompt", "string", "First 200 characters of the first user message, with whitespace collapsed."),
      field("userTurns", "number", "User messages."),
      field("turns", "number", "Assistant messages. Each one is one model request."),
      field("calls", "number", "Tool calls."),
      field("errorCalls", "number", "Tool calls whose result reported an error."),
      field("truncatedCalls", "number", "Tool calls whose result Pi cut at its output limit."),
      field("tools", "object", "Tool call count by tool name."),
      field("callsBeforeFirstMutation", "number|null", "Tool calls before the first edit or write. Bash mutations do not count. Null when the session never edited or wrote a file."),
      field("inputTokens", "number", "Sum of uncached input tokens over all turns."),
      field("outputTokens", "number", "Sum of output tokens over all turns."),
      field("cacheReadTokens", "number", "Sum of cache-read tokens over all turns."),
      field("cacheWriteTokens", "number", "Sum of cache-write tokens over all turns."),
      field("peakContextTokens", "number", "Largest input plus cache-read plus cache-write of any one turn."),
      field("cost", "number|null", "Sum of the cost recorded per turn, in the provider's currency. Null when the source records no cost, as with Claude Code."),
      field("resultBytes", "number", "Sum of tool result text bytes."),
      field("systemPromptBytes", "number", "Bytes of the first system prompt, over all of its sections. 0 when the source does not record it, as with Claude Code."),
      field("compactions", "number", "Compaction entries."),
    ],
  },
  turns: {
    description: "One row per assistant message, which is one model request: model, tokens, cost, and timing.",
    fields: [
      SESSION_FIELD,
      field("turn", "number", "1-based index of the assistant message in the session. calls.turn joins to it."),
      field("line", "number", "Line of the assistant message in the session file."),
      field("userTurn", "number", "Count of user messages so far. All turns that answer one prompt share it."),
      field("startedAt", "string|null", "When the agent started the request. Null for Claude Code, which does not record it."),
      field("endedAt", "string|null", "When the finished message was appended. For Claude Code, when its last block arrived."),
      field("generationMs", "number|null", "endedAt minus startedAt."),
      field("model", "string|null", "Model id."),
      field("provider", "string|null", "Provider id."),
      field("stopReason", "string|null", "Why the model stopped, for example toolUse or stop."),
      field("thinkingLevel", "string|null", "Thinking level of the request."),
      field("inputTokens", "number", "Uncached input tokens."),
      field("outputTokens", "number", "Output tokens."),
      field("cacheReadTokens", "number", "Input tokens read from cache."),
      field("cacheWriteTokens", "number", "Input tokens written to cache."),
      field("reasoningTokens", "number", "Reasoning tokens, where the provider reports them."),
      field("contextTokens", "number", "inputTokens plus cacheReadTokens plus cacheWriteTokens: the context this request carried."),
      field("cost", "number|null", "Cost recorded for the request. Null when the source records none."),
      field("textBytes", "number", "Bytes of visible text in the message."),
      field("thinkingBytes", "number", "Bytes of thinking text in the message."),
      field("calls", "number", "Tool calls in the message."),
      field("tools", "string[]", "Tool names in call order."),
    ],
  },
  calls: {
    description: "One row per tool call, joined to its result: what ran, how long, how much came back, and whether it failed.",
    fields: [
      SESSION_FIELD,
      field("seq", "number", "1-based index of the call in the session."),
      field("turn", "number", "turns.turn of the assistant message that made the call."),
      field("userTurn", "number", "Count of user messages so far."),
      field("line", "number", "Line of the assistant message in the session file."),
      field("resultLine", "number|null", "Line of the tool result. Null when the session has no result for the call."),
      field("callId", "string", "Tool call id. Joins to toolCallId in the store streams."),
      field("tool", "string", "Tool name. The core tools are bash, read, edit, and write for every source; other tools keep the name their agent gives them."),
      field("model", "string|null", "Model that made the call."),
      field("path", "string|null", "The path argument. Relative to the session cwd when inside it."),
      field("command", "string|null", "The command argument of a bash call, in full."),
      field("classes", "string[]", "Command classes, for example test or build, from the built-in rules and the project's .dvdst/config.json."),
      field("reads", "string[]", "Files the call read. For bash, inferred from the command text: cat, sed -n, rg, and similar. Relative to the session cwd when inside it."),
      field("mutates", "string[]", "Files the call changed. For bash, inferred from the command text: sed -i, redirections, rm, and similar."),
      field("opaque", "string[]", "Reasons a bash call may change files its text does not name, for example an inline script."),
      field("argBytes", "number", "Bytes of the serialized arguments."),
      field("startedAt", "string|null", "When the call was recorded: for Pi, when the assistant message was appended; for Claude Code, when the call's own block arrived."),
      field("endedAt", "string|null", "Timestamp of the tool result."),
      field("durationMs", "number|null", "endedAt minus startedAt. For Pi calls made in one message it is an upper bound, because they share startedAt."),
      field("isError", "boolean|null", "Whether the result reported an error. Null without a result."),
      field("exitCode", "number|null", "Exit code a failed bash result names. Null when the result names none."),
      field("resultBytes", "number|null", "Bytes of result text."),
      field("resultLines", "number|null", "Lines of result text."),
      field("truncated", "boolean|null", "Whether the agent cut the result at its output limit."),
      field("args", "object", "Full arguments. Only with --full."),
      field("resultText", "string", "Full result text. Only with --full."),
    ],
  },
  context: {
    description: "One row per system prompt section: what the session started with and how large each part was.",
    fields: [
      SESSION_FIELD,
      field("line", "number", "Line of the system message in the session file."),
      field("section", "string", "Section name, for example rules, skills, or project_context."),
      field("bytes", "number", "Bytes of the section."),
      field("text", "string", "Section text. Only with --full."),
    ],
  },
};

export type Row = Record<string, unknown>;

export interface SessionRows {
  overview: Row;
  turns: Row[];
  calls: Row[];
  context: Row[];
}

// Pi ends a cut result with a line range; Claude Code replaces it with a pointer to a saved file.
const TRUNCATION_MARKER = /\[Showing lines \d+-\d+ of \d+[^\]]*\]\s*$|^<persisted-output>/;
// Pi ends a failed bash result with the exit code; Claude Code starts with it.
const EXIT_CODE = /Command exited with code (\d+)\s*$|^Exit code (\d+)\b/;
const MUTATING_TOOLS = new Set(["edit", "write"]);

function bytes(text: string): number {
  return Buffer.byteLength(text);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Pi writes entry timestamps as ISO strings and message timestamps as epoch milliseconds. */
function isoTimestamp(value: unknown): string | null {
  if (typeof value === "string") return Number.isNaN(Date.parse(value)) ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return null;
}

function elapsed(start: string | null, end: string | null): number | null {
  if (start === null || end === null) return null;
  return Date.parse(end) - Date.parse(start);
}

function blocks(content: unknown): Array<Record<string, unknown>> {
  return Array.isArray(content) ? content.filter(isObject) : [];
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return blocks(content)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

function relativeToCwd(path: string, cwd: string | null): string {
  if (cwd === null || !path.startsWith("/")) return path;
  const rel = relative(cwd, path);
  return rel.length === 0 || rel.startsWith("..") ? path : rel;
}

/**
 * Derives the analysis rows of one session from its parsed entries.
 *
 * The rows are a pure function of the session file. They carry the session id
 * and source lines, so a consumer can concatenate many sessions and still
 * trace any row back to the entry it came from.
 */
export function deriveRows(records: SourceRecord[], sourcePath: string, options: { full?: boolean; commandClasses?: CommandClassRule[] } = {}): SessionRows {
  const full = options.full === true;
  const commandClasses = options.commandClasses ?? [];
  const path = resolve(sourcePath);
  let session = sessionIdFromFilename(basename(sourcePath)) ?? basename(sourcePath);
  let cwd: string | null = null;
  let source = "pi";
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let firstPrompt: string | undefined;
  let userTurn = 0;
  let compactions = 0;
  let systemPromptBytes: number | undefined;

  const turns: Row[] = [];
  const calls: Row[] = [];
  const context: Row[] = [];
  const pending = new Map<string, Row>();
  const models: string[] = [];

  for (const record of records) {
    const entry = record.value;
    if (!isObject(entry)) continue;
    const line = record.source.line;
    const entryTime = isoTimestamp(entry.timestamp);
    if (entryTime !== null) endedAt = entryTime;

    if (entry.type === "session") {
      if (typeof entry.id === "string") session = entry.id;
      cwd = stringOrNull(entry.cwd);
      if (typeof entry.source === "string") source = entry.source;
      startedAt = entryTime;
      continue;
    }
    if (entry.type === "compaction") compactions += 1;
    const message = entry.message;
    if (!isObject(message)) continue;

    if (message.role === "user") {
      userTurn += 1;
      firstPrompt ??= textOf(message.content).replace(/\s+/g, " ").trim().slice(0, 200);
      continue;
    }

    if (message.role === "system" && isObject(message.sections)) {
      let total = 0;
      for (const [section, value] of Object.entries(message.sections)) {
        const text = typeof value === "string" ? value : JSON.stringify(value);
        total += bytes(text);
        context.push({ session, line, section, bytes: bytes(text), ...(full ? { text } : {}) });
      }
      systemPromptBytes ??= total;
      continue;
    }

    if (message.role === "assistant") {
      const turn = turns.length + 1;
      const content = blocks(message.content);
      const usage = isObject(message.usage) ? message.usage : {};
      const cost = isObject(usage.cost) ? usage.cost : {};
      const model = stringOrNull(message.model);
      if (model !== null && !models.includes(model)) models.push(model);
      const toolCalls = content.filter((block) => block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string");
      const requestedAt = isoTimestamp(message.timestamp);
      const inputTokens = numberOrZero(usage.input);
      const cacheReadTokens = numberOrZero(usage.cacheRead);
      const cacheWriteTokens = numberOrZero(usage.cacheWrite);
      turns.push({
        session,
        turn,
        line,
        userTurn,
        startedAt: requestedAt,
        endedAt: entryTime,
        generationMs: elapsed(requestedAt, entryTime),
        model,
        provider: stringOrNull(message.provider),
        stopReason: stringOrNull(message.stopReason),
        thinkingLevel: stringOrNull(message.thinkingLevel),
        inputTokens,
        outputTokens: numberOrZero(usage.output),
        cacheReadTokens,
        cacheWriteTokens,
        reasoningTokens: numberOrZero(usage.reasoning),
        contextTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
        cost: typeof cost.total === "number" ? cost.total : null,
        textBytes: bytes(textOf(content)),
        thinkingBytes: content.reduce((sum, block) => sum + (block.type === "thinking" && typeof block.thinking === "string" ? bytes(block.thinking) : 0), 0),
        calls: toolCalls.length,
        tools: toolCalls.map((block) => block.name as string),
      });

      for (const block of toolCalls) {
        const args = isObject(block.arguments) ? block.arguments : {};
        const command = block.name === "bash" ? stringOrNull(args.command) : null;
        const path = typeof args.path === "string" ? relativeToCwd(args.path, cwd) : null;
        const bash = command === null ? { effects: [], opaque: [] } : parseBashEffects(command);
        const bashPaths = (effect: "read" | "mutation"): string[] => [...new Set(bash.effects.filter((entry) => entry.effect === effect).map((entry) => relativeToCwd(entry.path, cwd)))];
        const call: Row = {
          session,
          seq: calls.length + 1,
          turn,
          userTurn,
          line,
          resultLine: null,
          callId: block.id,
          tool: block.name,
          model,
          path,
          command,
          classes: command === null ? [] : classifyCommand(command, commandClasses),
          reads: command !== null ? bashPaths("read") : block.name === "read" && path !== null ? [path] : [],
          mutates: command !== null ? bashPaths("mutation") : MUTATING_TOOLS.has(block.name as string) && path !== null ? [path] : [],
          opaque: bash.opaque,
          argBytes: bytes(JSON.stringify(args)),
          startedAt: isoTimestamp(block.timestamp) ?? entryTime,
          endedAt: null,
          durationMs: null,
          isError: null,
          exitCode: null,
          resultBytes: null,
          resultLines: null,
          truncated: null,
          ...(full ? { args } : {}),
        };
        calls.push(call);
        pending.set(block.id as string, call);
      }
      continue;
    }

    if (typeof message.toolCallId === "string") {
      const call = pending.get(message.toolCallId);
      if (call === undefined) continue;
      pending.delete(message.toolCallId);
      const text = textOf(message.content);
      const finishedAt = isoTimestamp(message.timestamp) ?? entryTime;
      const exit = EXIT_CODE.exec(text);
      call.resultLine = line;
      call.endedAt = finishedAt;
      call.durationMs = elapsed(call.startedAt as string | null, finishedAt);
      call.isError = message.isError === true;
      call.exitCode = exit === null ? null : Number(exit[1] ?? exit[2]);
      call.resultBytes = bytes(text);
      call.resultLines = text.length === 0 ? 0 : text.split("\n").length;
      call.truncated = TRUNCATION_MARKER.test(text);
      if (full) call.resultText = text;
    }
  }

  const tools: Record<string, number> = {};
  for (const call of calls) tools[call.tool as string] = (tools[call.tool as string] ?? 0) + 1;
  const firstMutation = calls.findIndex((call) => MUTATING_TOOLS.has(call.tool as string));
  const sum = (rows: Row[], key: string): number => rows.reduce((total, row) => total + numberOrZero(row[key]), 0);

  const overview: Row = {
    session,
    source,
    path,
    cwd,
    startedAt,
    endedAt,
    wallMs: elapsed(startedAt, endedAt),
    lines: records.length,
    models,
    firstPrompt: firstPrompt ?? "",
    userTurns: userTurn,
    turns: turns.length,
    calls: calls.length,
    errorCalls: calls.filter((call) => call.isError === true).length,
    truncatedCalls: calls.filter((call) => call.truncated === true).length,
    tools: Object.fromEntries(Object.entries(tools).sort(([left], [right]) => left.localeCompare(right))),
    callsBeforeFirstMutation: firstMutation < 0 ? null : firstMutation,
    inputTokens: sum(turns, "inputTokens"),
    outputTokens: sum(turns, "outputTokens"),
    cacheReadTokens: sum(turns, "cacheReadTokens"),
    cacheWriteTokens: sum(turns, "cacheWriteTokens"),
    peakContextTokens: turns.reduce((peak, row) => Math.max(peak, numberOrZero(row.contextTokens)), 0),
    cost: turns.some((row) => row.cost !== null) ? sum(turns, "cost") : null,
    resultBytes: sum(calls, "resultBytes"),
    systemPromptBytes: systemPromptBytes ?? 0,
    compactions,
  };

  // Rows created before the header was read would carry the filename id.
  for (const row of [...turns, ...calls, ...context]) row.session = session;
  return { overview, turns, calls, context };
}
