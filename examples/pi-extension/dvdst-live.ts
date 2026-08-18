// Install or link this as a Pi extension. It writes an append-only local stream;
// it does not add messages, change provider requests, or alter compaction.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const source = "pi.extension";

export default function (pi: ExtensionAPI) {
  let sequence = 0;
  let streamPath: string | undefined;
  let initialization: Promise<void> | undefined;
  let writes = Promise.resolve();

  async function initialize(sessionId: string, cwd: string): Promise<void> {
    streamPath = join(process.env.DVDST_LIVE_DIR ?? join(cwd, ".dvdst", "live"), `${sessionId}.jsonl`);
    await mkdir(dirname(streamPath), { recursive: true, mode: 0o700 });
    // Resume the sequence after /reload or another extension runtime restart.
    const previous = await readFile(streamPath, "utf8").catch(() => "");
    for (const line of previous.trimEnd().split("\n").reverse()) {
      if (!line) continue;
      try {
        const record = JSON.parse(line) as { sequence?: unknown };
        if (typeof record.sequence === "number" && Number.isSafeInteger(record.sequence)) {
          sequence = record.sequence + 1;
          break;
        }
      } catch {
        // dvdst live will surface malformed persisted input; do not overwrite it.
      }
    }
  }

  async function emit(type: string, data: unknown, ctx: { cwd: string; sessionManager: { getSessionId(): string } }): Promise<void> {
    const sessionId = ctx.sessionManager.getSessionId();
    initialization ??= initialize(sessionId, ctx.cwd);
    await initialization;
    const event = JSON.stringify({
      schemaVersion: 1,
      source,
      sessionId,
      sequence: sequence++,
      observedAt: new Date().toISOString(),
      type,
      data,
    });
    writes = writes.then(() => appendFile(streamPath!, `${event}\n`, { mode: 0o600 }));
    await writes;
  }

  pi.on("session_start", async (event, ctx) => emit("session.started", { reason: event.reason }, ctx));
  pi.on("message_end", async (event, ctx) => emit("message.finalized", { message: event.message }, ctx));
  pi.on("tool_execution_start", async (event, ctx) => emit("tool.started", {
    toolCallId: event.toolCallId, toolName: event.toolName, args: event.args,
  }, ctx));
  pi.on("tool_execution_update", async (event, ctx) => emit("tool.updated", {
    toolCallId: event.toolCallId, toolName: event.toolName, args: event.args, partialResult: event.partialResult,
  }, ctx));
  pi.on("tool_execution_end", async (event, ctx) => emit("tool.finished", {
    toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError,
  }, ctx));
  pi.on("session_compact", async (event, ctx) => emit("session.compacted", {
    reason: event.reason, willRetry: event.willRetry, fromExtension: event.fromExtension, compactionEntry: event.compactionEntry,
  }, ctx));
  pi.on("session_tree", async (event, ctx) => emit("branch.selected", {
    oldLeafId: event.oldLeafId, newLeafId: event.newLeafId, fromExtension: event.fromExtension,
  }, ctx));
  pi.on("session_shutdown", async (event, ctx) => {
    await emit("session.ended", { reason: event.reason }, ctx);
    await writes;
  });
}
