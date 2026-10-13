import { isAbsolute, resolve } from "node:path";
import type { SourceRecord } from "../pi/read-jsonl.js";
import type { CollectedStage, StagePatch } from "./stage.js";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter(object).map(part => typeof part.text === "string" ? part.text : "").join("\n");
  return "";
}

// Never execute recorded JavaScript. Only this single literal call is evidence.
function wrappedPatch(input: string): string | undefined {
  const match = /^\s*text\(await tools\.apply_patch\(("(?:[^"\\]|\\.)*")\)\);?\s*$/.exec(input);
  return match ? JSON.parse(match[1]!) as string : undefined;
}

function succeeded(output: unknown, wrapper = false): boolean {
  const text = outputText(output);
  if (wrapper && !/^Script completed\n/.test(text)) return false;
  // This exec runtime's apply_patch returns an empty object on success and
  // throws on failure. The strict wrapper cannot catch or mask that failure.
  if (wrapper && Array.isArray(output) && /^Script completed\n/.test(text) && text.trimEnd().endsWith("\n{}")) return true;
  try {
    const value: unknown = JSON.parse(text);
    if (object(value)) {
      if (object(value.metadata) && value.metadata.exit_code !== 0) return false;
      if (value.isError === true) return false;
      return succeeded(value.output ?? value.content);
    }
  } catch { /* Native tools and exec wrappers can return plain text. */ }
  // Printed JSON inside a successful exec is also a supported tool result.
  for (const line of text.split("\n")) {
    if (line.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (object(parsed) && succeeded(line)) return true;
      } catch { /* not JSON */ }
    }
  }
  return /(?:^|\n)Success\. Updated the following files:\r?\n/.test(text)
    && !/(?:^|\n)(?:Error|Failed|apply_patch verification failed)/.test(text);
}

/** Exact textual hunks only; no fuzzy placement, deletion, or move inference. */
function patches(input: string, cwd: string, sourceEventId: string, resultEventId: string): StagePatch[] {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.shift() !== "*** Begin Patch" || lines.pop() !== "*** End Patch") throw new Error("invalid successful Codex patch envelope");
  const result: StagePatch[] = [];
  let i = 0;
  while (i < lines.length) {
    const header = /^\*\*\* (Add|Update) File: (.+)$/.exec(lines[i++]!);
    if (!header) throw new Error("Codex staging supports Add File and Update File; deletes and moves have no supported ownership pre-image");
    const path = resolve(cwd, header[2]!);
    if (header[1] === "Add") {
      const content: string[] = [];
      while (i < lines.length && !lines[i]!.startsWith("*** ")) {
        const line = lines[i++]!;
        if (!line.startsWith("+")) throw new Error("invalid Codex Add File line");
        content.push(line.slice(1));
      }
      result.push({ path, operation: "write", edits: [], content: content.length ? `${content.join("\n")}\n` : "", sourceEventId, resultEventId });
      continue;
    }
    const edits: StagePatch["edits"] = [];
    while (i < lines.length && !lines[i]!.startsWith("*** ")) {
      const marker = lines[i++]!;
      if (marker !== "@@" && !marker.startsWith("@@ ")) throw new Error("invalid Codex Update File hunk");
      const before: string[] = [], after: string[] = [];
      while (i < lines.length && !lines[i]!.startsWith("@@") && !lines[i]!.startsWith("*** ")) {
        const line = lines[i++]!;
        if (line.startsWith(" ")) { before.push(line.slice(1)); after.push(line.slice(1)); }
        else if (line.startsWith("-")) before.push(line.slice(1));
        else if (line.startsWith("+")) after.push(line.slice(1));
        else throw new Error("invalid Codex Update File line");
      }
      const endOfFile = lines[i] === "*** End of File";
      if (endOfFile) i++;
      if (before.length === 0) throw new Error("Codex update requires a nonempty exact pre-image hunk");
      // A trailing newline is deliberately part of the anchor. Unrepresented
      // newline changes are refused rather than guessed from the worktree.
      edits.push({ oldText: `${before.join("\n")}\n`, newText: after.length ? `${after.join("\n")}\n` : "", lineAnchor: true, ...(endOfFile ? { endOfFile: true } : {}) });
    }
    if (!edits.length) throw new Error("Codex update has no hunks");
    result.push({ path, operation: "edit", orderedAnchors: true, edits, content: undefined, sourceEventId, resultEventId });
  }
  if (!result.length) throw new Error("Codex patch has no mutations");
  if (new Set(result.map(patch => patch.path)).size !== result.length) throw new Error("Codex patch repeats a path; split it into separate calls");
  return result;
}

export function collectCodexStage(records: SourceRecord[]): CollectedStage {
  const collected: CollectedStage = { agent: "codex", sessionId: undefined, cwd: undefined, patches: [], bash: [] };
  let cwd: string | undefined;
  const calls = new Map<string, { patch?: string; bash?: string; wrapper: boolean; cwd: string; id: string }>();
  const finished = new Set<string>();
  for (const { value, source } of records) {
    if (!object(value) || !object(value.payload)) continue;
    const payload = value.payload;
    if (value.type === "session_meta") {
      if (collected.sessionId !== undefined || typeof payload.id !== "string" || typeof payload.cwd !== "string" || !isAbsolute(payload.cwd)) throw new Error("Codex rollout requires one session_meta with id and absolute cwd");
      if (payload.history_base !== undefined || payload.forked_from_id !== undefined) throw new Error("forked Codex history is unsupported; use a fresh session");
      collected.sessionId = payload.id;
      collected.cwd = cwd = payload.cwd;
    } else if (value.type === "turn_context" && typeof payload.cwd === "string") {
      if (!isAbsolute(payload.cwd)) throw new Error("Codex turn cwd must be absolute");
      cwd = payload.cwd;
    }
    else if (value.type === "response_item") {
      if ((payload.type === "custom_tool_call" || payload.type === "function_call") && typeof payload.call_id === "string") {
        if (!cwd) throw new Error("Codex call has no recorded cwd");
        if (calls.has(payload.call_id)) throw new Error("duplicate Codex tool call");
        const name = typeof payload.name === "string" ? payload.name.replace(/^functions\./, "") : "";
        let patch: string | undefined, bash: string | undefined;
        if (name === "apply_patch") {
          if (payload.type === "custom_tool_call" && typeof payload.input === "string") patch = payload.input;
          else {
            const args: unknown = JSON.parse(String(payload.arguments));
            if (object(args) && typeof (args.patch ?? args.input) === "string") patch = (args.patch ?? args.input) as string;
          }
          if (patch === undefined) throw new Error("invalid Codex apply_patch arguments");
        } else if (name === "exec" && typeof payload.input === "string") {
          patch = wrappedPatch(payload.input);
          if (patch === undefined) bash = payload.input; // heuristic warning only
        } else if (name === "exec_command" || name === "shell_command" || name === "shell") {
          const args: unknown = JSON.parse(String(payload.arguments));
          if (object(args) && typeof (args.cmd ?? args.command) === "string") bash = (args.cmd ?? args.command) as string;
        }
        calls.set(payload.call_id, { ...(patch === undefined ? {} : { patch }), ...(bash === undefined ? {} : { bash }), wrapper: name === "exec", cwd, id: `codex:call:${payload.call_id}` });
      } else if ((payload.type === "custom_tool_call_output" || payload.type === "function_call_output") && typeof payload.call_id === "string") {
        const call = calls.get(payload.call_id);
        if (!call) continue;
        if (finished.has(payload.call_id)) throw new Error("duplicate Codex tool result");
        finished.add(payload.call_id);
        const resultId = `codex:result:${payload.call_id}`;
        if (call.patch !== undefined && succeeded(payload.output, call.wrapper)) collected.patches.push(...patches(call.patch, call.cwd, call.id, resultId));
        if (call.bash !== undefined) collected.bash.push({ command: call.bash, toolCallId: payload.call_id, sourceEventId: call.id });
      }
    }
  }
  if (!collected.sessionId) throw new Error("Codex rollout has no session_meta");
  return collected;
}
