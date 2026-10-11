import { isObject, type SourceRecord } from "../pi/read-jsonl.js";

/**
 * Claude Code writes one entry per content block, so one model request spans
 * several entries that share a message id. Tool results arrive as blocks of a
 * user entry. There is no header: every entry carries the session id and cwd.
 */

const META_PROMPT = /^\s*(<(command-name|command-message|local-command-[a-z]+|task-notification|system-reminder)\b|\[Request interrupted by user)/;

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isObject)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

/**
 * Gives the core tools the tool names and argument keys the rest of dvdst
 * reads. The original arguments stay in place beside the added keys.
 */
function canonicalCall(name: string, input: Record<string, unknown>): { name: string; arguments: Record<string, unknown> } {
  const path = typeof input.file_path === "string" ? { path: input.file_path } : {};
  switch (name) {
    case "Bash":
      return { name: "bash", arguments: input };
    case "Read":
      return { name: "read", arguments: { ...input, ...path } };
    case "Write":
      return { name: "write", arguments: { ...input, ...path } };
    case "Edit":
      return { name: "edit", arguments: { ...input, ...path, edits: [{ oldText: input.old_string, newText: input.new_string }] } };
    case "MultiEdit":
      return {
        name: "edit",
        arguments: { ...input, ...path, edits: (Array.isArray(input.edits) ? input.edits.filter(isObject) : []).map((edit) => ({ oldText: edit.old_string, newText: edit.new_string })) },
      };
    default:
      return { name, arguments: input };
  }
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function isClaudeEntry(value: unknown): boolean {
  return isObject(value) && typeof value.sessionId === "string" && typeof value.type === "string" && value.type !== "session";
}

/**
 * Converts Claude Code transcript entries to the entry shape dvdst reads.
 *
 * Each output record keeps the line and byte range of the transcript entry it
 * came from. A model request becomes one assistant message at the line of its
 * first block, and each tool call keeps the timestamp of its own block.
 * Subagent sidechain entries and client bookkeeping entries are left out.
 */
export function claudeToCanonical(records: SourceRecord[]): SourceRecord[] {
  const output: SourceRecord[] = [];
  const assistantById = new Map<string, { message: Record<string, unknown>; entry: Record<string, unknown>; outputTokens: number }>();
  const toolNames = new Map<string, string>();
  let header: Record<string, unknown> | undefined;

  for (const record of records) {
    const entry = record.value;
    if (!isObject(entry) || entry.isSidechain === true) continue;
    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;

    if (header === undefined && typeof entry.sessionId === "string") {
      header = { type: "session", id: entry.sessionId, source: "claude" };
      output.unshift({ value: header, source: { ...record.source, entryId: entry.sessionId } });
    }
    if (header !== undefined) {
      if (header.cwd === undefined && typeof entry.cwd === "string") header.cwd = entry.cwd;
      if (header.timestamp === undefined && timestamp !== undefined) header.timestamp = timestamp;
      if (header.version === undefined && typeof entry.version === "string") header.version = entry.version;
    }

    if (entry.type === "system" && entry.subtype === "compact_boundary") {
      output.push({ value: { type: "compaction", id: entry.uuid, timestamp }, source: record.source });
      continue;
    }
    const message = entry.message;
    if (!isObject(message)) continue;
    const id = typeof entry.uuid === "string" ? entry.uuid : `entry:${record.source.line}`;

    if (entry.type === "assistant") {
      const messageId = typeof message.id === "string" ? message.id : id;
      let merged = assistantById.get(messageId);
      if (merged === undefined) {
        const canonical: Record<string, unknown> = { role: "assistant", provider: "anthropic", model: message.model, content: [] };
        const canonicalEntry: Record<string, unknown> = { type: "message", id: messageId, parentId: entry.parentUuid ?? null, timestamp, message: canonical };
        merged = { message: canonical, entry: canonicalEntry, outputTokens: -1 };
        assistantById.set(messageId, merged);
        output.push({ value: canonicalEntry, source: { ...record.source, entryId: messageId } });
      }
      // The request ended when its last block arrived.
      if (timestamp !== undefined) merged.entry.timestamp = timestamp;
      if (typeof message.stop_reason === "string") merged.message.stopReason = message.stop_reason;
      if (typeof entry.effort === "string") merged.message.thinkingLevel = entry.effort;
      const usage = isObject(message.usage) ? message.usage : undefined;
      // Every block repeats the usage of its request; the fullest count is the final one.
      if (usage !== undefined && number(usage.output_tokens) > merged.outputTokens) {
        merged.outputTokens = number(usage.output_tokens);
        const details = isObject(usage.output_tokens_details) ? usage.output_tokens_details : {};
        merged.message.usage = {
          input: number(usage.input_tokens),
          output: number(usage.output_tokens),
          cacheRead: number(usage.cache_read_input_tokens),
          cacheWrite: number(usage.cache_creation_input_tokens),
          reasoning: number(details.thinking_tokens),
        };
      }
      const content = merged.message.content as unknown[];
      for (const block of Array.isArray(message.content) ? message.content.filter(isObject) : []) {
        if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          const call = canonicalCall(block.name, isObject(block.input) ? block.input : {});
          toolNames.set(block.id, call.name);
          content.push({ type: "toolCall", id: block.id, name: call.name, arguments: call.arguments, timestamp });
        } else if (block.type === "thinking") {
          content.push({ type: "thinking", thinking: typeof block.thinking === "string" ? block.thinking : "" });
        } else if (block.type === "text") {
          content.push({ type: "text", text: typeof block.text === "string" ? block.text : "" });
        }
      }
      continue;
    }

    if (entry.type !== "user") continue;
    const blocks = Array.isArray(message.content) ? message.content.filter(isObject) : [];
    const results = blocks.filter((block) => block.type === "tool_result" && typeof block.tool_use_id === "string");
    for (const [index, block] of results.entries()) {
      const toolCallId = block.tool_use_id as string;
      output.push({
        value: {
          type: "message",
          id: `${id}:${index}`,
          parentId: entry.parentUuid ?? null,
          timestamp,
          message: {
            role: "toolResult",
            toolCallId,
            toolName: toolNames.get(toolCallId) ?? "unknown",
            isError: block.is_error === true,
            content: [{ type: "text", text: text(block.content) }],
            ...(entry.toolUseResult === undefined ? {} : { details: entry.toolUseResult }),
          },
        },
        source: { ...record.source, entryId: `${id}:${index}` },
      });
    }
    if (results.length > 0) continue;

    const prompt = text(message.content);
    // Slash-command echoes, task notifications, interrupt markers, and injected context are not prompts.
    if (entry.isMeta === true || entry.isCompactSummary === true || prompt.length === 0 || META_PROMPT.test(prompt)) continue;
    output.push({
      value: { type: "message", id, parentId: entry.parentUuid ?? null, timestamp, message: { role: "user", content: [{ type: "text", text: prompt }] } },
      source: { ...record.source, entryId: id },
    });
  }
  return output;
}
