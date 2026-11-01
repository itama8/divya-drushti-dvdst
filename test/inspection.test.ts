import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { queryInspection } from "../src/analysis/inspection.js";
import { INSPECTION_SCHEMAS } from "../src/analysis/inspection-schema.js";
import { loadSessionFile } from "../src/analysis/session.js";
import { readCall } from "../src/analysis/read-call.js";
import { readMessage } from "../src/analysis/conversation.js";
import { ingestSessionFile } from "../src/store/ingest-session.js";
import { extractArtifacts } from "../src/artifacts/extract.js";
import { normalizeSnapshot } from "../src/normalize/normalize.js";

const cli = (...args: string[]) => spawnSync(process.execPath, ["bin/dvdst.mjs", ...args], { encoding: "utf8", env: { ...process.env, DVDST_CACHE: "off" } });
const msg = (id: string, role: string, content: unknown, extra = {}) => ({ type: "message", id, message: { role, content, ...extra } });
const text = (text: string) => [{ type: "text", text }];
const tc = (id: string, name: string, args: unknown) => ({ type: "toolCall", id, name, arguments: args });
const body = "---\nname: inspect\n---\nFollow the evidence.";
const pi = [
  { type: "session", id: "shared", cwd: "/work/app", timestamp: "2026-10-01T00:00:00Z" },
  msg("u", "user", text(`<skill name="inspect" location="/work/app/skills/inspect/SKILL.md">\n${body}\n</skill>`)),
  msg("a", "assistant", [tc("load", "read", { path: "skills/inspect/SKILL.md" })]),
  msg("r", "toolResult", text(body), { toolCallId: "load", isError: false }),
  msg("a2", "assistant", [tc("test", "bash", { command: "npm test " + "😀".repeat(300) }), tc("shell", "bash", { command: "cat src/a.ts > out.txt" }), tc("write", "write", { path: "src/a.ts", content: "new" }), tc("failed", "read", { path: "skills/fail/SKILL.md" }), tc("pending", "read", { path: "skills/pending/SKILL.md" })]),
  msg("r2", "toolResult", text("failed"), { toolCallId: "test", isError: true }),
  msg("r3", "toolResult", text("denied"), { toolCallId: "failed", isError: true }),
  msg("r4", "toolResult", text(""), { toolCallId: "shell", isError: false }),
  msg("end", "assistant", text("Done?")),
  msg("u2", "user", text("Next task")),
  msg("a3", "assistant", [tc("later", "write", { path: "later.ts", content: "x" })]),
];
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
async function fixture(run: (file: string, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "dvdst-inspection-"));
  try { const file = join(root, "session.jsonl"); await writeFile(file, jsonl(pi)); await run(file, root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const exp = (kind: string, ...args: string[]) => cli(kind, "--contract", "exploration", ...args);

describe("unified inspection queries", () => {
  it("keeps attempted file targets separate from inferred effects and recorded outcomes", async () => fixture(async file => {
    const session = await loadSessionFile(file);
    const page = queryInspection(session, "files");
    const write = page.rows.find(row => row.callId === "write")!;
    assert.equal(write.outcome, "unfinished");
    assert.equal(write.resultSource, null);
    assert.equal(write.basis, "explicit-file-tool");
    assert.equal(queryInspection(session, "files", { basis: "inferred-shell" }).matched, 2);
    assert.deepEqual(queryInspection(session, "files", { path: "out.txt" }).rows.map(row => [row.operation, row.basis]), [["mutation", "inferred-shell"]]);
    assert.equal(queryInspection(session, "files", { outcome: "failed", operation: "read" }).matched, 1);
    const raw = await readFile(file);
    for (const row of page.rows) {
      assert.deepEqual(Object.keys(row).sort(), INSPECTION_SCHEMAS.files.fields.map(field => field.name).sort());
      const entry = JSON.parse(raw.subarray(row.byteStart as number, row.byteEnd as number).toString());
      assert.equal(entry.message.role, "assistant");
      assert.equal((await readCall({ ref: row.ref as string })).call.callId, row.callId);
      assert.equal((await readMessage({ ref: row.messageRef as string, before: 0, after: 0 })).messages[0]!.role, "assistant");
    }
  }));

  it("bounds commands in Unicode code points and expands the rest through existing readers", async () => fixture(async file => {
    const session = await loadSessionFile(file);
    const page = queryInspection(session, "commands", { class: "test", textLimit: 12 });
    assert.equal(page.matched, 1);
    const row = page.rows[0]!;
    assert.deepEqual(Object.keys(row).sort(), INSPECTION_SCHEMAS.commands.fields.map(field => field.name).sort());
    const command = row.command as { text: string; nextOffset: number; totalChars: number };
    assert.equal(Array.from(command.text).length, 12);
    assert.equal(command.nextOffset, 12);
    assert.equal(command.totalChars, 309);
    assert.equal(row.outcome, "failed");
    const expanded = await readCall({ ref: row.ref as string, commandOffset: 12, limit: 12 });
    assert.equal(expanded.command!.text, "😀".repeat(12));
    assert.equal(queryInspection(session, "commands", { outcome: "succeeded" }).matched, 1);
  }));

  it("retains failed/unconfirmed skill loads and traverses every attribution membership", async () => fixture(async file => {
    const session = await loadSessionFile(file);
    const rows = queryInspection(session, "skills").rows;
    assert.deepEqual(rows.map(row => row.loadStatus), ["expanded", "loaded", "failed", "unconfirmed"]);
    assert.deepEqual(rows.map(row => row.confidence), ["observed", "reconstructed", "reconstructed", "reconstructed"]);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), INSPECTION_SCHEMAS.skills.fields.map(field => field.name).sort());
      assert.equal((await readMessage({ ref: row.messageRef as string, before: 0, after: 0 })).messages[0]!.line, row.line);
      if (["failed", "unconfirmed"].includes(row.loadStatus as string)) assert.equal(row.activeStartLine, null);
    }
    assert.equal(queryInspection(session, "skills", { loadStatus: "unconfirmed" }).matched, 1);
    assert.equal(queryInspection(session, "skills", { name: "inspect", view: "spans" }).matched, 2);
    const attrs = queryInspection(session, "skills", { view: "attributions", limit: 100 }).rows;
    assert.ok(attrs.some(row => row.attributionBasis === "within-turn-window"));
    assert.ok(!attrs.some(row => row.recordId === "later"));
    for (const row of attrs) {
      if (row.refKind === "call") assert.equal((await readCall({ ref: row.ref as string })).call.callId, row.recordId);
      else assert.equal((await readMessage({ ref: row.ref as string, before: 0, after: 0 })).messages[0]!.id, row.recordId);
    }
    assert.equal(queryInspection(session, "skills", { loadStatus: "failed", view: "attributions" }).matched, 1, "failed loads have only a trigger association");
  }));

  it("enforces default row/text bounds without leaking argument/result payloads", async () => fixture(async (file) => {
    const calls = Array.from({ length: 25 }, (_, i) => tc(`c${i}`, "bash", { command: "npm test " + "x".repeat(2000), privateArgument: "ARGUMENT SENTINEL" }));
    await writeFile(file, jsonl([pi[0], msg("a", "assistant", calls), msg("r", "toolResult", text("RESULT SENTINEL"), { toolCallId: "c0", isError: false })]));
    const result = exp("commands", file, "--page");
    assert.equal(result.status, 0, result.stderr);
    const page = JSON.parse(result.stdout);
    assert.deepEqual([page.matched, page.returned, page.nextOffset], [25, 20, 20]);
    assert.ok(page.rows.every((row: { command: { text: string; nextOffset: number } }) => row.command.text.length === 240 && row.command.nextOffset === 240));
    assert.ok(!result.stdout.includes("ARGUMENT SENTINEL"));
    assert.ok(!result.stdout.includes("RESULT SENTINEL"));
    assert.equal(JSON.parse(exp("commands", file, "--offset", "20", "--page").stdout).returned, 5);
  }));

  it("does not invent file effects for unknown tools and uses nonzero recorded exits as failure", async () => fixture(async file => {
    await writeFile(file, jsonl([pi[0], msg("a", "assistant", [tc("unknown", "custom", { path: "invented.ts" }), tc("run", "bash", { command: "cat src/a.ts" })]),
      msg("r", "toolResult", text("exit"), { toolCallId: "run", isError: false, details: { exitCode: 2 } })]));
    const session = await loadSessionFile(file);
    assert.equal(queryInspection(session, "files").matched, 1);
    assert.equal(queryInspection(session, "files").rows[0]!.outcome, "failed");
    assert.equal(queryInspection(session, "commands").rows[0]!.isError, false);
    assert.equal(queryInspection(session, "commands").rows[0]!.outcome, "failed");
    assert.equal((await readCall({ session: file, id: "unknown" })).call.tool, "custom");
    assert.throws(() => queryInspection(session, "commands", { limit: 0 }), /whole number/);
    assert.throws(() => queryInspection(session, "commands", { path: "src" }), /does not apply/);
    assert.throws(() => queryInspection(session, "files", { basis: "wat" as "inferred-shell" }), /Invalid basis/);
    assert.throws(() => queryInspection({ ...session, calls: session.calls.map(({ args: _args, ...row }) => row) }, "files"), /full SessionData/);
  }));

  it("paginates/project across segments without conflating shared session IDs", async () => fixture(async (file, root) => {
    const second = join(root, "second.jsonl"); await writeFile(second, jsonl(pi));
    const result = exp("commands", file, second, "--limit", "1", "--offset", "1", "--fields", "session,segment,ref", "--page");
    assert.equal(result.status, 0, result.stderr);
    const page = JSON.parse(result.stdout);
    assert.deepEqual([page.matched, page.returned, page.nextOffset, page.complete, page.selectedSources], [4, 1, 2, true, 2]);
    assert.deepEqual(Object.keys(page.rows[0]), ["session", "segment", "ref"]);
    const next = JSON.parse(exp("commands", file, second, "--limit", "1", "--offset", "2", "--page").stdout);
    assert.equal(next.rows[0].segment, resolve(second));
    assert.notEqual(page.rows[0].ref, next.rows[0].ref);
    const end = JSON.parse(exp("commands", file, second, "--offset", "9", "--page").stdout);
    assert.equal(end.returned, 0); assert.equal(end.nextOffset, null);
  }));

  it("reports failures after a full page, including truncated source lines", async () => fixture(async (file, root) => {
    const bad = join(root, "bad.jsonl"); await writeFile(bad, jsonl(pi) + '{"type":');
    const result = exp("files", file, bad, "--limit", "1", "--page");
    assert.equal(result.status, 1);
    const page = JSON.parse(result.stdout);
    assert.equal(page.returned, 1); assert.equal(page.complete, false);
    assert.equal(page.readSources, 1); assert.equal(page.selectedSources, 2);
    assert.equal(page.failedSources[0].path, bad);
    assert.match(page.failedSources[0].error, /JSONL/);
  }));

  it("shares direct/stored exploration rows, reads raw snapshots without derived writes, and pins references", async () => fixture(async (file, root) => {
    const store = join(root, "store"); const ingested = await ingestSessionFile(file, store);
    const before = await readdir(ingested.snapshot, { recursive: true });
    for (const kind of ["files", "commands", "skills"] as const) {
      const direct = JSON.parse(exp(kind, file, "--page").stdout);
      const result = exp(kind, "--store", store, "--session", "shared", "--snapshot", ingested.sourceHash, "--page");
      assert.equal(result.status, 0, result.stderr);
      const stored = JSON.parse(result.stdout);
      assert.equal(stored.selectionMode, "store"); assert.equal(stored.snapshot, ingested.sourceHash);
      const stable = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => !["segment", "ref", "messageRef"].includes(key)));
      assert.deepEqual(stored.rows.map(stable), direct.rows.map(stable));
      if (stored.rows[0].refKind === "call") assert.equal((await readCall({ ref: stored.rows[0].ref })).call.callId, stored.rows[0].callId);
      else assert.ok((await readMessage({ ref: stored.rows[0].ref })).messages.length > 0);
    }
    assert.deepEqual(await readdir(ingested.snapshot, { recursive: true }), before);
    const ref = JSON.parse(exp("commands", file, "--page").stdout).rows[0].ref;
    await writeFile(file, jsonl(pi) + "\n");
    await assert.rejects(readCall({ ref }), /Stale/);
    const stored = JSON.parse(exp("commands", "--store", store, "--session", "shared", "--page").stdout);
    assert.ok(await readCall({ ref: stored.rows[0].ref }));
  }));

  it("refuses corrupted stored bytes with structured source failure metadata", async () => fixture(async (file, root) => {
    const store = join(root, "store"); const snapshot = await ingestSessionFile(file, store);
    await writeFile(join(snapshot.snapshot, "source", "raw.jsonl"), jsonl(pi) + "\n");
    const result = exp("files", "--store", store, "--session", snapshot.sessionId, "--page");
    assert.equal(result.status, 1);
    const page = JSON.parse(result.stdout);
    assert.equal(page.complete, false); assert.equal(page.returned, 0);
    assert.match(page.failedSources[0].error, /fingerprint/);
  }));

  it("keeps legacy direct/store distinctions instead of replacing artifact meanings", async () => fixture(async (file, root) => {
    const direct = cli("files", file, "--format", "json");
    assert.equal(direct.status, 0, direct.stderr);
    assert.ok(!JSON.parse(direct.stdout).some((row: { path: string }) => row.path === "out.txt"));
    const store = join(root, "store"); const ingested = await ingestSessionFile(file, store);
    await normalizeSnapshot({ store, sessionId: ingested.sessionId });
    await extractArtifacts({ store, sessionId: ingested.sessionId });
    const stored = cli("files", "--store", store, "--session", ingested.sessionId, "--format", "json");
    assert.equal(stored.status, 0, stored.stderr);
    assert.ok(!JSON.parse(stored.stdout).some((row: { path: string }) => row.path === "out.txt"), "shell effects are a separate stored artifact");
    assert.deepEqual(Object.keys(JSON.parse(stored.stdout)[0]).sort(), ["count", "operations", "path"]);
    assert.ok(Object.hasOwn(JSON.parse(direct.stdout)[0], "firstSource"));
    const shellEffects = await readFile(join(ingested.snapshot, "artifacts", "bash-file-effects.jsonl"), "utf8");
    assert.match(shellEffects, /out.txt/);
    const directCommands = JSON.parse(cli("commands", file, "--format", "json").stdout);
    const storedCommands = JSON.parse(cli("commands", "--store", store, "--session", ingested.sessionId, "--format", "json").stdout);
    assert.ok(Object.hasOwn(directCommands[0].result, "textBytes"));
    assert.ok(Object.hasOwn(storedCommands[0].result, "outputBytes"));
    assert.match(cli("files", file).stdout, /^path\toperations\tcount\n/);
    assert.equal(cli("files", "--help").status, 0);
  }));

  it("validates modes, fields, bounds, formats and command-specific options before emitting success", async () => fixture(async (file, root) => {
    for (const args of [
      ["--limit", "0"], ["--offset", "-1"], ["--limit", "1.5"], ["--fields", "path,path"], ["--fields", "typo"], ["--format", "wat"], ["--page", "--format", "tsv"], ["--operation", "remove"], ["--class", "test"],
      ["--store", root, "--session", "shared"],
    ]) {
      const result = exp("files", file, ...args);
      assert.equal(result.status, 1, args.join(" ")); assert.equal(result.stdout, "");
    }
    for (const args of [["--store", root], ["--snapshot", "bad"], ["--store", root, "--session", "shared", "--source", "all"]]) assert.equal(exp("files", ...args).status, 1);
    assert.match(cli("files", file, "--limit", "1").stderr, /requires --contract exploration/);
    assert.equal(exp("commands", file, "--text-limit", "4097").status, 1);
    assert.equal(exp("skills", file, "--load-status", "wat").status, 1);
    for (const format of ["jsonl", "json", "tsv"]) {
      const result = exp("files", file, "--fields", "path,outcome", "--format", format, "--limit", "1");
      assert.equal(result.status, 0, result.stderr);
      assert.ok(!result.stdout.includes("fingerprint"));
    }
  }));

  it("supports source/project/root/time/session-count discovery through the shared resolver", async () => fixture(async (_file, root) => {
    const result = exp("files", "--root", root, "--source", "all", "--project", "app", "--since", "2026-09-30", "--last", "1", "--limit", "1", "--page");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).selectedSources, 1);
  }));

  it("preserves Claude block provenance, Codex patches/running calls, and direct/store parity across sources", async () => fixture(async (_file, root) => {
    const claude = [
      { type: "user", sessionId: "claude-query", uuid: "u", cwd: "/work/app", message: { role: "user", content: "Inspect" } },
      { type: "assistant", uuid: "a1", message: { id: "merged", role: "assistant", content: [{ type: "text", text: "Loading" }] } },
      { type: "assistant", uuid: "a2", message: { id: "merged", role: "assistant", content: [{ type: "tool_use", id: "load", name: "Read", input: { file_path: "skills/inspect/SKILL.md" } }] } },
      { type: "user", uuid: "r", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "load", content: body }] } },
      { type: "assistant", uuid: "a3", message: { id: "next", role: "assistant", content: [{ type: "tool_use", id: "run", name: "Bash", input: { command: "npm test" } }] } },
    ];
    const codex = [
      { type: "session_meta", payload: { id: "codex-query", cwd: "/work/app" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect" }] } },
      { type: "response_item", payload: { type: "function_call", name: "read", call_id: "load", arguments: JSON.stringify({ path: "skills/inspect/SKILL.md" }) } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "load", output: body } },
      { type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "patch", input: "*** Begin Patch\n*** Add File: src/new.ts\n+hello\n*** End Patch" } },
      { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "run", arguments: '{"cmd":"npm test"}' } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "run", output: '{"session_id":42,"output":"running"}' } },
    ];
    for (const [source, records] of [["claude", claude], ["codex", codex]] as const) {
      const file = join(root, `${source}.jsonl`); await writeFile(file, jsonl(records));
      const session = await loadSessionFile(file);
      assert.equal(session.source, source);
      const files = queryInspection(session, "files").rows;
      const load = files.find(row => row.callId === "load")!;
      assert.equal(load.line, 3);
      assert.equal((await readCall({ ref: load.ref as string })).call.callId, "load");
      const entry = JSON.parse((await readFile(file)).subarray(load.byteStart as number, load.byteEnd as number).toString());
      assert.equal(entry.type, source === "claude" ? "assistant" : "response_item");
      assert.equal(queryInspection(session, "skills").rows[0]!.loadStatus, "loaded");
      assert.equal(queryInspection(session, "commands").rows[0]!.outcome, "unfinished");
      if (source === "codex") assert.equal(files.find(row => row.callId === "patch")!.outcome, "unfinished");
      const store = join(root, "store"); const snapshot = await ingestSessionFile(file, store);
      for (const kind of ["files", "commands", "skills"] as const) {
        const result = exp(kind, "--store", store, "--session", snapshot.sessionId, "--page");
        assert.equal(result.status, 0, result.stderr);
        const stored = JSON.parse(result.stdout).rows;
        const stable = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => !["segment", "ref", "messageRef"].includes(key)));
        assert.deepEqual(stored.map(stable), queryInspection(session, kind).rows.map(stable));
        for (const row of stored) {
          assert.equal(row.source, source);
          if (row.refKind === "call") assert.equal((await readCall({ ref: row.ref })).call.callId, row.callId);
          else assert.ok(await readMessage({ ref: row.ref }));
        }
      }
      if (source === "codex") {
        const completed = [...records,
          { type: "response_item", payload: { type: "function_call", name: "write_stdin", call_id: "poll", arguments: '{"session_id":42}' } },
          { type: "response_item", payload: { type: "function_call_output", call_id: "poll", output: '{"exit_code":0,"output":"passed"}' } },
        ];
        await writeFile(file, jsonl(completed));
        const row = queryInspection(await loadSessionFile(file), "commands").rows[0]!;
        assert.equal(row.outcome, "succeeded");
        assert.equal((row.resultSource as { line: number }).line, completed.length);
        assert.equal((await readCall({ ref: row.ref as string })).call.exitCode, 0);
      }
    }
  }));
});
