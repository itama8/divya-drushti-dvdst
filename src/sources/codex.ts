import { literalToolCalls } from "../stage/codex-exec.js";
import { isObject, type SourceRecord } from "../pi/read-jsonl.js";

/** Patch paths are recorded intent, not proof of successful writes or exact diffs. */
export function patchPaths(input: string): string[] {
  return [...new Set([...input.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(match => match[1]!.trim()))];
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter(isObject).map(block => typeof block.text === "string" ? block.text : "").join("\n");
  return JSON.stringify(value) ?? "";
}

function args(value: unknown): Record<string, unknown> {
  if (isObject(value)) return value;
  if (typeof value === "string") {
    try { const parsed: unknown = JSON.parse(value); if (isObject(parsed)) return parsed; } catch { /* retain opaque arguments */ }
  }
  return { input: value };
}

/** Unwrap only the existing literal grammar with one printed result per call. */
function expandLiteralExec(records: SourceRecord[]): SourceRecord[] {
  const outputs = new Map<string, SourceRecord>();
  for (const record of records) {
    const e = record.value;
    if (isObject(e) && e.type === "response_item" && isObject(e.payload) && e.payload.type === "custom_tool_call_output" && typeof e.payload.call_id === "string") outputs.set(e.payload.call_id, record);
  }
  const expanded = new Map<string, Array<{ name: string; argument: unknown; output: unknown }>>();
  for (const record of records) {
    const e = record.value;
    if (!isObject(e) || e.type !== "response_item" || !isObject(e.payload)) continue;
    const p = e.payload;
    if (p.type !== "custom_tool_call" || !["exec", "functions.exec"].includes(String(p.name)) || typeof p.input !== "string" || typeof p.call_id !== "string") continue;
    const calls = literalToolCalls(p.input);
    const result = outputs.get(p.call_id)?.value;
    if (!calls || !isObject(result) || !isObject(result.payload)) continue;
    const rendered = text(result.payload.output);
    if (!rendered.startsWith("Script completed\n") || !rendered.includes("Output:\n")) continue;
    const body = rendered.slice(rendered.indexOf("Output:\n") + "Output:\n".length);
    const values: unknown[] = [];
    try { for (const line of body.split("\n").filter(line => line.trim())) values.push(JSON.parse(line)); } catch { continue; }
    if (values.length !== calls.length || calls.some(call => !["apply_patch", "exec_command", "write_stdin"].includes(call.name))) continue;
    expanded.set(p.call_id, calls.map((call, i) => ({ ...call, output: values[i] })));
  }
  return records.flatMap(record => {
    const e = record.value;
    if (!isObject(e) || !isObject(e.payload) || typeof e.payload.call_id !== "string") return [record];
    const p = e.payload;
    const calls = expanded.get(p.call_id as string);
    if (!calls) return [record];
    return calls.map((call, i) => ({ ...record, value: { ...e, payload: p.type === "custom_tool_call" ? {
      type: call.name === "apply_patch" ? "custom_tool_call" : "function_call", call_id: `${p.call_id}:${i}`, name: call.name,
      ...(call.name === "apply_patch" ? { input: call.argument } : { arguments: JSON.stringify(call.argument) }),
    } : { type: "function_call_output", call_id: `${p.call_id}:${i}`, output: typeof call.output === "string" ? call.output : JSON.stringify(call.output) } } }));
  });
}

/** Convert only recorded response items; event_msg echoes must never double count them. */
export function codexToCanonical(records: SourceRecord[]): SourceRecord[] {
  const output: SourceRecord[] = [];
  const calls = new Map<string, string>();
  const shellSessions = new Map<string, string>();
  const pollSessions = new Map<string, string>();
  let model: unknown;
  let provider: unknown;
  let effort: unknown;
  let lastAssistant: Record<string, unknown> | undefined;
  let usageAssigned = true;
  for (const record of expandLiteralExec(records)) {
    const entry = record.value;
    if (!isObject(entry) || !isObject(entry.payload)) continue;
    const p = entry.payload;
    const id = typeof p.call_id === "string" ? `codex:${p.type}:${p.call_id}` : `codex:${record.source.line}`;
    const emit = (value: Record<string, unknown>) => output.push({
      value: { id, timestamp: entry.timestamp, ...value },
      source: { ...record.source, entryId: typeof value.id === "string" ? value.id : id },
    });
    if (entry.type === "session_meta") {
      provider = p.model_provider;
      emit({ type: "session", id: p.id, cwd: p.cwd, timestamp: p.timestamp ?? entry.timestamp, version: p.cli_version, source: "codex" });
      if (isObject(p.base_instructions) && typeof p.base_instructions.text === "string") {
        emit({ type: "message", id: `${id}:instructions`, message: { role: "system", sections: { base_instructions: p.base_instructions.text } } });
      }
    } else if (entry.type === "turn_context") {
      model = p.model;
      effort = p.effort;
    } else if (entry.type === "compacted") {
      emit({ type: "compaction" });
    } else if (entry.type === "event_msg" && p.type === "token_count") {
      const usage = isObject(p.info) && isObject(p.info.last_token_usage) ? p.info.last_token_usage : undefined;
      // Usage is a request observation, not a cumulative session total. Repeated
      // notifications between responses must not add the same request twice.
      if (usage && lastAssistant && !usageAssigned) {
        const n = (key: string) => typeof usage[key] === "number" ? usage[key] as number : 0;
        const cached = n("cached_input_tokens");
        lastAssistant.usage = { input: Math.max(0, n("input_tokens") - cached), cacheRead: cached, output: n("output_tokens"), reasoning: n("reasoning_output_tokens") };
        usageAssigned = true;
      }
    } else if (entry.type === "response_item") {
      if (p.type === "message" && (p.role === "user" || p.role === "assistant" || p.role === "developer")) {
        if (p.role === "user" && /^\s*<(?:environment_context|permissions instructions)>/.test(text(p.content))) continue;
        const message = { role: p.role, model, provider, thinkingLevel: effort, content: [{ type: "text", text: text(p.content) }] };
        emit({ type: "message", message });
        if (p.role === "assistant") { lastAssistant = message; usageAssigned = false; }
      } else if ((p.type === "function_call" || p.type === "custom_tool_call") && typeof p.call_id === "string" && typeof p.name === "string") {
        let name = p.name.replace(/^functions\./, "");
        let input = args(p.arguments ?? p.input);
        if (["exec_command", "shell_command", "shell"].includes(name)) {
          name = "bash";
          input = { ...input, command: Array.isArray(input.command) ? input.command.join(" ") : input.cmd ?? input.command };
        } else if (name === "apply_patch") {
          const patch = typeof p.input === "string" ? p.input : input.patch ?? input.input;
          input = { ...input, patch, paths: typeof patch === "string" ? patchPaths(patch) : [] };
        }
        if (name === "write_stdin" && input.session_id !== undefined) pollSessions.set(p.call_id, String(input.session_id));
        calls.set(p.call_id, name);
        const message = { role: "assistant", model, provider, thinkingLevel: effort, content: [{ type: "toolCall", id: p.call_id, name, arguments: input }] };
        emit({ type: "message", message });
        lastAssistant = message;
        usageAssigned = false;
      } else if ((p.type === "function_call_output" || p.type === "custom_tool_call_output") && typeof p.call_id === "string") {
        const resultText = text(p.output);
        let details: Record<string, unknown> = {};
        try { const parsed: unknown = JSON.parse(resultText); if (isObject(parsed)) details = parsed; } catch { /* plain tool result */ }
        const metadata = isObject(details.metadata) ? details.metadata : {};
        const exit = details.exit_code ?? metadata.exit_code ?? /(?:Process exited with code|exited with code|Exit code:)\s*(-?\d+)/i.exec(resultText)?.[1];
        const shellSession = details.session_id ?? /Process running with session ID (\d+)/.exec(resultText)?.[1];
        if (shellSession !== undefined && exit === undefined && calls.get(p.call_id) === "bash") {
          shellSessions.set(String(shellSession), p.call_id);
          continue;
        }
        if (exit !== undefined && Number.isFinite(Number(exit))) details.exitCode = Number(exit);
        const isError = details.isError === true || (exit !== undefined && Number(exit) !== 0) || /^(?:Error|Failed|Script failed|apply_patch verification failed)\b/m.test(resultText);
        const polledSession = pollSessions.get(p.call_id);
        const original = polledSession === undefined ? undefined : shellSessions.get(polledSession);
        if (original !== undefined && exit !== undefined) {
          emit({ type: "message", id: `${id}:completion`, message: { role: "toolResult", toolCallId: original, toolName: "bash", isError, content: [{ type: "text", text: resultText }], details } });
          shellSessions.delete(polledSession!);
        }
        emit({ type: "message", message: { role: "toolResult", toolCallId: p.call_id, toolName: calls.get(p.call_id) ?? "unknown", isError, content: [{ type: "text", text: resultText }], details } });
      }
    }
  }
  return output;
}
