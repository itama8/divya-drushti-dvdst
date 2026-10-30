import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { loadSessionFile } from "../src/analysis/session.js";
import { readCall } from "../src/analysis/read-call.js";
import { buildProbeBundle } from "../src/probe/build-bundle.js";
import { buildHandoffSummary } from "../src/handoff/summary.js";

const fixture = "test/fixtures/claude-session.jsonl";
const cli = (...args: string[]) => spawnSync(process.execPath, ["bin/dvdst.mjs", ...args], { encoding: "utf8", env: { ...process.env, DVDST_CACHE: "off" } });
let messageId = 0;
const message = (role: string, content: unknown, extra = {}) => ({ type: "message", id: `entry-${messageId++}`, message: { role, content, ...extra } });
const call = (id: string, name = "bash", args: unknown = { command: "npm test" }) => message("assistant", [{ type: "toolCall", id, name, arguments: args }]);
const result = (id: string, isError = false, text = "ok") => message("toolResult", [{ type: "text", text }], { toolCallId: id, isError });
const header = { type: "session", id: "shared-session", cwd: "/work/app" };
async function temporary(run: (root: string, file: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "dvdst-exploration-"));
  try { await run(root, join(root, "session.jsonl")); } finally { await rm(root, { recursive: true, force: true }); }
}
const save = (file: string, records: unknown[]) => writeFile(file, records.map(row => JSON.stringify(row)).join("\n") + "\n");

describe("bounded exploration", () => {
  it("composes filtering, global pagination and projection in each output format", () => {
    const args = ["calls", fixture, "--class", "test", "--fields", "session,seq,callId", "--limit", "1"];
    const json = cli(...args, "--format", "json");
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), [{ session: "claude-fixture", seq: 2, callId: "t2" }]);
    assert.equal(cli(...args).stdout, '{"session":"claude-fixture","seq":2,"callId":"t2"}\n');
    assert.equal(cli(...args, "--format", "tsv").stdout, "session\tseq\tcallId\nclaude-fixture\t2\tt2\n");
    const page = cli("calls", fixture, "--offset", "1", "--limit", "1", "--fields", "callId");
    assert.equal(page.stdout, '{"callId":"t2"}\n');
    assert.equal(cli("calls", fixture, "--seq", "3", "--fields", "callId").stdout, '{"callId":"t3"}\n');
    assert.equal(cli("calls", fixture, "--id", "t1", "--fields", "callId").stdout, '{"callId":"t1"}\n');
  });

  it("applies offset/limit across segments and preserves failures beyond the page", async () => temporary(async (root, file) => {
    await save(file, [header, call("one"), result("one")]);
    const second = join(root, "second.jsonl");
    await save(second, [header, call("two"), result("two")]);
    const page = cli("calls", file, second, "--offset", "1", "--limit", "1", "--fields", "callId");
    assert.equal(page.status, 0, page.stderr);
    assert.equal(page.stdout, '{"callId":"two"}\n');
    await writeFile(second, "{bad\n");
    const partial = cli("calls", file, second, "--limit", "1");
    assert.equal(partial.status, 1);
    assert.equal(partial.stdout.trim().split("\n").length, 1);
    assert.match(partial.stderr, /1 of 2 sessions/);
  }));

  it("rejects malformed controls and payload projection without --full", () => {
    for (const args of [["--limit", "0"], ["--offset", "-1"], ["--seq", "1.2"], ["--fields", "typo"], ["--fields", "seq,seq"], ["--fields", "args"]]) {
      const response = cli("calls", fixture, ...args);
      assert.equal(response.status, 1, args.join(" "));
      assert.equal(response.stdout, "");
    }
    assert.equal(cli("turns", fixture, "--seq", "1").status, 1);
  });

  it("retrieves a read call via the emitted reference and exposes the new schema", async () => {
    const listed = cli("calls", fixture, "--id", "t1", "--fields", "ref");
    const { ref } = JSON.parse(listed.stdout);
    const expanded = cli("call", "--ref", ref, "--limit", "8");
    assert.equal(expanded.status, 0, expanded.stderr);
    const value = JSON.parse(expanded.stdout);
    assert.equal(value.call.callId, "t1");
    assert.equal(value.result.text.length, 8);
    assert.equal(value.result.nextOffset, 8);
    assert.equal(value.args.truncated, true);
    assert.equal("command" in value.call, false);
    const next = await readCall({ ref, limit: 8, resultOffset: 8 });
    assert.equal(next.result?.offset, 8);
    assert.equal(next.result?.text, (await readCall({ ref })).result?.text.slice(8, 16));
    assert.equal(cli("schema", "call", "--format", "json").status, 0);
    assert.equal(cli("call", "--help").status, 0);
  });

  it("pins raw snapshot bytes and segment identity, including opaque tools and Unicode", async () => temporary(async (root, file) => {
    await save(file, [header, call("same", "custom_tool", { data: "😀".repeat(10000) }), result("same", false, "😀résult")]);
    const first = (await loadSessionFile(file)).calls[0]!;
    const ref = first.ref as string;
    const other = join(root, "other.jsonl");
    await save(other, [header, call("same", "custom_tool"), result("same", false, "other")]);
    assert.notEqual(ref, (await loadSessionFile(other)).calls[0]!.ref);
    const retrieved = await readCall({ ref, limit: 2 });
    assert.equal(retrieved.call.tool, "custom_tool");
    assert.equal(retrieved.path, resolve(file));
    assert.equal(retrieved.result?.text, "😀r");
    assert.equal((await readCall({ ref, limit: 2, resultOffset: 2 })).result?.text, "és");
    await assert.rejects(readCall({ ref, resultOffset: 999 }), /exceeds/);
    await assert.rejects(readCall({ ref, limit: 100000 }), /--limit/);
    await writeFile(file, (await readFile(file, "utf8")) + "\n");
    await assert.rejects(readCall({ ref }), /Stale call reference/);
    const refreshed = (await loadSessionFile(file)).calls[0]!.ref as string;
    assert.equal((await readCall({ ref: refreshed })).call.callId, "same");
  }));

  it("retrieves Codex calls with missing results without inventing output", async () => temporary(async (_root, file) => {
    await save(file, [
      { type: "session_meta", payload: { id: "codex", cwd: "/work/app" } },
      { type: "response_item", payload: { type: "function_call", name: "unknown", call_id: "orphan", arguments: '{"x":1}' } },
    ]);
    const response = await readCall({ session: file, id: "orphan" });
    assert.equal(response.source, "codex");
    assert.equal(response.result, null);
    assert.equal(response.call.isError, null);
    await assert.rejects(readCall({ session: file, id: "missing" }), /not found/);
    await assert.rejects(readCall({ ref: "broken" }), /Invalid call reference/);
    await assert.rejects(readCall({ session: file, id: "orphan", seq: 1 }), /exactly one/);
  }));

  it("refuses ambiguous IDs and conflicting selectors", async () => temporary(async (_root, file) => {
    await save(file, [header, call("duplicate"), result("duplicate"), call("duplicate"), result("duplicate")]);
    await assert.rejects(readCall({ session: file, id: "duplicate" }), /Ambiguous/);
    assert.equal((await readCall({ session: file, seq: 2 })).call.seq, 2);
    const ref = (await loadSessionFile(file)).calls[0]!.ref as string;
    await assert.rejects(readCall({ ref, session: file }), /--ref alone/);
    assert.equal(cli("call", file, "--id", "missing").status, 1);
  }));

  it("trace finds non-shell calls and reports not-found consistently", () => {
    const read = cli("trace", fixture, "--id", "t1", "--format", "json");
    assert.equal(read.status, 0, read.stderr);
    assert.equal(JSON.parse(read.stdout).callEntries[0].line, 4);
    for (const format of ["json", "text", "tsv"]) {
      const missing = cli("trace", fixture, "--id", "missing", "--format", format);
      assert.equal(missing.status, 1);
      if (format === "json") assert.equal(JSON.parse(missing.stdout).found, false);
    }
  });
});

describe("ordered handoff validation", () => {
  const cases = [
    { name: "unfinished", entries: [call("t")], outcome: "unfinished", completed: 0, failed: 0 },
    { name: "retry", entries: [call("t1"), result("t1", true), call("t2"), result("t2")], outcome: "stable", completed: 2, failed: 1 },
    { name: "stale", entries: [call("t"), result("t"), call("e", "edit", { path: "a.ts" }), result("e")], outcome: "validation-stale", completed: 1, failed: 0 },
    { name: "after-edit", entries: [call("e", "edit", { path: "a.ts" }), result("e"), call("t"), result("t")], outcome: "stable", completed: 1, failed: 0 },
    { name: "different-command", entries: [call("t1"), result("t1", true), call("t2", "bash", { command: "npm run build" }), result("t2")], outcome: "unresolved-failure", completed: 1, failed: 1 },
    { name: "retry-unfinished", entries: [call("t1"), result("t1", true), call("t2")], outcome: "unfinished", completed: 1, failed: 1 },
    { name: "different-workdir", entries: [call("t1", "bash", { command: "npm test", cwd: "/work/a" }), result("t1", true), call("t2", "bash", { command: "npm test", cwd: "/work/b" }), result("t2")], outcome: "unresolved-failure", completed: 2, failed: 1 },
    { name: "overlapping-tests", entries: [call("t1"), call("t2"), result("t1", true), result("t2")], outcome: "unresolved-failure", completed: 2, failed: 1 },
    { name: "opaque-effects", entries: [call("script", "bash", { command: "node -e 'modify()'" }), result("script"), call("t"), result("t")], outcome: "unknown", completed: 1, failed: 0 },
    { name: "parallel-edit-and-test", entries: [message("assistant", [{ type: "toolCall", id: "e", name: "edit", arguments: { path: "a.ts" } }, { type: "toolCall", id: "t", name: "bash", arguments: { command: "npm test" } }]), result("e"), result("t")], outcome: "validation-stale", completed: 1, failed: 0 },
  ];
  for (const item of cases) it(item.name, async () => temporary(async (_root, file) => {
    await save(file, [header, ...item.entries]);
    const summary = buildHandoffSummary(await buildProbeBundle({ sessionPath: file }));
    assert.equal(summary.outcome, item.outcome);
    assert.equal(summary.validation.completed, item.completed);
    assert.equal(summary.tests.ran, item.completed > 0);
    assert.equal(summary.validation.failed, item.failed);
    assert.equal(summary.commands.failed, item.failed);
    if (summary.validation.latestCommands.length > 0) assert.equal(typeof summary.validation.latestCommands[0]!.ref, "string");
  }));
});
