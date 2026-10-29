import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadSessionFile } from "../src/analysis/session.js";
import { buildProbeBundle } from "../src/probe/build-bundle.js";
import { resolveSessions } from "../src/pi/resolve-sessions.js";
import { ingestSessionFile } from "../src/store/ingest-session.js";
import { normalizeSnapshot } from "../src/normalize/normalize.js";
import { extractArtifacts } from "../src/artifacts/extract.js";
import { extractEvents } from "../src/events/extract.js";
import { codexToCanonical } from "../src/sources/codex.js";
import { deriveRows } from "../src/analysis/rows.js";
import { readSessionSnapshot } from "../src/store/read-session.js";

const id = "12345678-abcd-1234-abcd-123456789abc";
const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Add File: src/b.ts\n+b\n*** End Patch";
function rollout() {
  const rows: Array<[string, unknown]> = [
    ["session_meta", { id, cwd: "/work/app", model_provider: "openai", base_instructions: { text: "Be helpful" } }],
    ["turn_context", { model: "codex-test", effort: "high" }],
    ["response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Fix it" }] }],
    ["event_msg", { type: "user_message", message: "Fix it" }],
    ["response_item", { type: "function_call", name: "exec_command", call_id: "test", arguments: JSON.stringify({ cmd: "npm test" }) }],
    ["response_item", { type: "function_call_output", call_id: "test", output: JSON.stringify({ output: "failed", exit_code: 2 }) }],
    ["response_item", { type: "custom_tool_call", name: "apply_patch", call_id: "patch", input: patch }],
    ["response_item", { type: "custom_tool_call_output", call_id: "patch", output: "Success. Updated the following files:\nM src/a.ts\nA src/b.ts" }],
    ["response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] }],
    ["event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5 }, total_token_usage: { input_tokens: 9999 } } }],
    ["event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 } } }],
  ];
  return rows.map(([type, payload], i) => JSON.stringify({ type, payload, timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z` })).join("\n") + "\n";
}
async function fixture(run: (root: string, file: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "dvdst-analysis-"));
  try { const file = join(root, "rollout.jsonl"); await writeFile(file, rollout()); await run(root, file); }
  finally { await rm(root, { recursive: true, force: true }); }
}

describe("Codex analysis", () => {
  it("joins calls and preserves provenance, usage, failures, context and multi-file patches", async () => fixture(async (_root, file) => {
    const session = await loadSessionFile(file);
    assert.equal(session.source, "codex");
    assert.equal(session.overview.userTurns, 1);
    assert.equal(session.overview.inputTokens, 60);
    assert.equal(session.overview.cacheReadTokens, 40);
    assert.equal(session.overview.outputTokens, 20);
    assert.equal(session.overview.cost, null);
    assert.equal(session.calls.length, 2);
    assert.equal(session.calls[0]!.isError, true);
    assert.equal(session.calls[0]!.exitCode, 2);
    assert.equal(session.calls[0]!.line, 5);
    assert.equal(session.calls[0]!.resultLine, 6);
    assert.deepEqual(session.calls[1]!.mutates, ["src/a.ts", "src/b.ts"]);
    assert.equal(session.context[0]!.text, "Be helpful");
    const bundle = await buildProbeBundle({ sessionPath: file });
    assert.equal(bundle.commands.length, 1);
    assert.equal(bundle.files.length, 2);
    const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli/dvdst.ts", "handoff", file], { encoding: "utf8" });
    assert.match(output, /Modified files \(2\)/);
    assert.match(output, /Commands: total=1 failed=1 tests=1/);
  }));

  it("unwraps literal exec batches only when every result can be joined", () => {
    const entries = [
      { type: "session_meta", payload: { id, cwd: "/work/app" } },
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "wrapper", input: 'text(await tools.exec_command({cmd:"npm test"}));text(await tools.apply_patch("*** Begin Patch\\n*** Add File: new.ts\\n+x\\n*** End Patch"));' } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "wrapper", output: [{ type: "input_text", text: 'Script completed\nOutput:\n{"exit_code":2,"output":"failed"}\n{}' }] } },
    ];
    const records = entries.map((value, i) => ({ value, source: { line: i + 1, byteStart: i, byteEnd: i + 1 } }));
    const rows = deriveRows(codexToCanonical(records), "rollout.jsonl");
    assert.deepEqual(rows.calls.map(row => row.tool), ["bash", "apply_patch"]);
    assert.equal(rows.calls[0]!.isError, true);
    assert.deepEqual(rows.calls[1]!.mutates, ["new.ts"]);
    entries[1]!.payload = { ...entries[1]!.payload, input: 'const x = await tools.exec_command({cmd:"npm test"}); text(x);' } as typeof entries[1]["payload"];
    assert.equal(deriveRows(codexToCanonical(records), "rollout.jsonl").calls[0]!.tool, "exec");
  });

  it("leaves running shell calls unfinished until polling records an exit", () => {
    const entries = [
      { type: "session_meta", payload: { id, cwd: "/work/app" } },
      { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "run", arguments: '{"cmd":"npm test"}' } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "run", output: '{"session_id":42,"output":"running"}' } },
      { type: "response_item", payload: { type: "function_call", name: "write_stdin", call_id: "poll", arguments: '{"session_id":42}' } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "poll", output: '{"exit_code":1,"output":"failed"}' } },
    ];
    const records = entries.map((value, i) => ({ value, source: { line: i + 1, byteStart: i, byteEnd: i + 1 } }));
    assert.equal(deriveRows(codexToCanonical(records.slice(0, 3)), "rollout.jsonl").calls[0]!.isError, null);
    const rows = deriveRows(codexToCanonical(records), "rollout.jsonl");
    assert.equal(rows.calls[0]!.isError, true);
    assert.equal(rows.calls[0]!.resultLine, 5);
  });

  it("discovers date-partitioned rollouts by recorded cwd and session id", async () => fixture(async (home, file) => {
    const dir = join(home, ".codex", "sessions", "2026", "01", "01");
    await mkdir(dir, { recursive: true });
    const target = join(dir, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
    await copyFile(file, target);
    const options = { home, cwd: "/work/app", env: {}, source: "codex" as const };
    assert.deepEqual(await resolveSessions({ ...options, specs: ["latest"] }), [target]);
    assert.deepEqual(await resolveSessions({ ...options, project: "app", specs: [id.slice(0, 8)] }), [target]);
    assert.deepEqual(await resolveSessions({ ...options, source: "all", specs: [], last: 5 }), [target]);
  }));
});

describe("stored evidence across agents", () => {
  it("refuses ambiguous store identities across agents", async () => fixture(async (root, file) => {
    const store = join(root, "store");
    await ingestSessionFile(file, store);
    const claude = join(root, "claude.jsonl");
    await writeFile(claude, JSON.stringify({ type: "user", sessionId: id, cwd: "/work/app", message: { content: "hi" } }) + "\n");
    await ingestSessionFile(claude, store);
    await assert.rejects(readSessionSnapshot({ store, sessionId: id }), /Ambiguous session identity/);
  }));

  for (const agent of ["claude", "codex"] as const) {
    it(`preserves ${agent} bytes and produces artifacts and findings`, async () => fixture(async (root, codex) => {
      const file = agent === "codex" ? codex : "test/fixtures/claude-session.jsonl";
      const store = join(root, "store");
      const ingested = await ingestSessionFile(file, store);
      assert.ok(ingested.snapshot.includes(`/sessions/${agent}/`));
      const snapshot = await readSessionSnapshot({ store, sessionId: ingested.sessionId });
      assert.equal(await readFile(snapshot.rawPath, "utf8"), await readFile(file, "utf8"));
      const normalized = await normalizeSnapshot({ store, sessionId: ingested.sessionId });
      assert.equal(normalized.orphans.calls, 0);
      const artifacts = await extractArtifacts({ store, sessionId: ingested.sessionId });
      assert.ok(artifacts.counts.fileMutations > 0);
      assert.equal(artifacts.counts.commands, 1);
      const events = await extractEvents({ store, sessionId: ingested.sessionId });
      assert.ok(events);
      const again = await ingestSessionFile(file, store);
      assert.equal(again.status, "unchanged");
    }));
  }
});
