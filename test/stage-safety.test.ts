import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { collectStageFromSession, collectStagePatches, planPath, stageChanges, type StagePatch } from "../src/stage/stage.js";

const patch = (edits: StagePatch["edits"]): StagePatch => ({ path: "file.txt", operation: "edit", edits, content: undefined, sourceEventId: "call", resultEventId: "result" });
const event = (sequence: number, type: string, data: unknown, sessionId = "safety") => ({ schemaVersion: 1, source: "pi.extension", sessionId, sequence, observedAt: "2026-09-30T00:00:00Z", type, data });
function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dvdst-safety-"));
  git(root, "init", "-q");
  await writeFile(join(root, "file.txt"), "initial\nkeep\n");
  await writeFile(join(root, "other.txt"), "other\n");
  git(root, "add", ".");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@test", "commit", "-qm", "base");
  const input = join(root, "events.jsonl");
  async function stream(patches: StagePatch[]) {
    const events = patches.flatMap((p, i) => [
      event(i * 2, "tool.started", { toolCallId: `c${i}`, toolName: p.operation, args: p.operation === "edit" ? { path: p.path, edits: p.edits } : { path: p.path, content: p.content } }),
      event(i * 2 + 1, "tool.finished", { toolCallId: `c${i}`, isError: false }),
    ]);
    await writeFile(input, events.map(e => JSON.stringify(e)).join("\n") + "\n");
  }
  return { root, input, stream };
}

describe("session staging safety", () => {
  it("matches all edits against the original content", () => {
    const result = planPath("A B\n", [patch([{ oldText: "A", newText: "B" }, { oldText: "B", newText: "C" }])]);
    assert.equal(result.status, "staged");
    if (result.status === "staged") assert.equal(result.content, "B C\n");
  });

  it("rejects overlapping and missing anchors instead of guessing", () => {
    assert.equal(planPath("abc", [patch([{ oldText: "ab", newText: "x" }, { oldText: "bc", newText: "y" }])]).status, "conflict");
    assert.equal(planPath("unrelated new", [patch([{ oldText: "missing", newText: "new" }])]).status, "conflict");
  });

  it("rejects mixed sessions and replayed live events", () => {
    assert.throws(() => collectStagePatches([event(0, "agent.settled", {}), event(1, "agent.settled", {}, "foreign")]), /session/i);
    assert.throws(() => collectStagePatches([event(0, "agent.settled", {}), event(0, "agent.settled", {})]), /sequence|duplicate/i);
  });

  it("does not silently drop malformed session records", () => {
    assert.throws(() => collectStageFromSession('{"type":"session","id":"s"}\nnot-json\n'), /line 2|JSON/i);
  });

  it("refuses a mismatched expected session", async () => {
    const f = await fixture();
    await f.stream([patch([{ oldText: "initial", newText: "final" }])]);
    await assert.rejects(stageChanges({ input: f.input, cwd: f.root, session: "foreign" }), /session/i);
    assert.equal(git(f.root, "diff", "--cached"), "");
  });

  it("replays chained edits, deletions, and a later staging extension exactly", async () => {
    const f = await fixture();
    const first = patch([{ oldText: "initial", newText: "middle" }]);
    const second = patch([{ oldText: "middle", newText: "final" }, { oldText: "keep\n", newText: "" }]);
    await f.stream([first]);
    assert.equal((await stageChanges({ input: f.input, cwd: f.root })).conflicts.length, 0);
    await f.stream([first, second]);
    assert.equal((await stageChanges({ input: f.input, cwd: f.root })).conflicts.length, 0);
    assert.equal(git(f.root, "show", ":file.txt"), "final\n");
    const repeat = await stageChanges({ input: f.input, cwd: f.root });
    assert.deepEqual(repeat.staged, []);
    assert.deepEqual(repeat.unchanged, ["file.txt"]);
  });

  it("refuses a whole-file write to an existing tracked file", async () => {
    const f = await fixture();
    await f.stream([{ ...patch([]), operation: "write", content: "replacement\n" }]);
    const report = await stageChanges({ input: f.input, cwd: f.root });
    assert.match(report.conflicts[0]?.reason ?? "", /write|pre-image/i);
    assert.equal(git(f.root, "diff", "--cached"), "");
  });

  it("preserves foreign staged changes, even on another path", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "other.txt"), "foreign\n");
    git(f.root, "add", "other.txt");
    const before = git(f.root, "diff", "--cached");
    await f.stream([patch([{ oldText: "initial", newText: "final" }])]);
    const report = await stageChanges({ input: f.input, cwd: f.root });
    assert.ok(report.conflicts.length > 0);
    assert.deepEqual(report.staged, []);
    assert.equal(git(f.root, "diff", "--cached"), before);
  });

  it("preserves foreign staged content on an owned path", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "file.txt"), "initial\nforeign staged\n");
    git(f.root, "add", "file.txt");
    const before = git(f.root, "diff", "--cached");
    await f.stream([patch([{ oldText: "initial", newText: "final" }])]);
    const report = await stageChanges({ input: f.input, cwd: f.root });
    assert.ok(report.conflicts.length > 0);
    assert.equal(git(f.root, "diff", "--cached"), before);
  });

  it("does not partially stage when another path conflicts", async () => {
    const f = await fixture();
    await f.stream([patch([{ oldText: "initial", newText: "final" }]), { ...patch([{ oldText: "missing", newText: "x" }]), path: "other.txt" }]);
    assert.ok((await stageChanges({ input: f.input, cwd: f.root })).conflicts.length > 0);
    assert.equal(git(f.root, "diff", "--cached"), "");
  });

  it("scopes two repositories without rebasing relative session paths", async () => {
    const first = await fixture();
    const second = await fixture();
    const events = [
      event(0, "session.started", { cwd: first.root }),
      event(1, "tool.started", { toolCallId: "a", toolName: "edit", args: { path: "file.txt", edits: [{ oldText: "initial", newText: "first" }] } }),
      event(2, "tool.finished", { toolCallId: "a", isError: false }),
      event(3, "tool.started", { toolCallId: "b", toolName: "edit", args: { path: join(second.root, "file.txt"), edits: [{ oldText: "initial", newText: "second" }] } }),
      event(4, "tool.finished", { toolCallId: "b", isError: false }),
    ];
    await writeFile(first.input, events.map(e => JSON.stringify(e)).join("\n") + "\n");
    const a = await stageChanges({ input: first.input, cwd: first.root });
    const b = await stageChanges({ input: first.input, cwd: second.root });
    assert.deepEqual(a.conflicts, []);
    assert.deepEqual(b.conflicts, []);
    assert.equal(a.excluded.length, 1);
    assert.equal(b.excluded.length, 1);
    assert.equal(git(first.root, "show", ":file.txt"), "first\nkeep\n");
    assert.equal(git(second.root, "show", ":file.txt"), "second\nkeep\n");
  });

  it("rejects cancellation before acquiring the index lock", async () => {
    const f = await fixture();
    await f.stream([patch([{ oldText: "initial", newText: "final" }])]);
    const cancellation = new AbortController();
    cancellation.abort();
    await assert.rejects(stageChanges({ input: f.input, cwd: f.root, signal: cancellation.signal }), /abort/i);
    assert.equal(git(f.root, "diff", "--cached"), "");
    await assert.rejects(readFile(join(f.root, ".git/index.lock")), { code: "ENOENT" });
  });

  it("releases the index lock when the real CLI is cancelled during preparation", { timeout: 10_000 }, async () => {
    const f = await fixture();
    const before = await readFile(join(f.root, ".git/index"));
    const writes = Array.from({ length: 20 }, (_, i) => ({ ...patch([]), operation: "write" as const, path: `new-${i}.txt`, content: "payload\n" }));
    await f.stream(writes);
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli/stage.ts", "--input", f.input, "--cwd", f.root], { cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: ["ignore", "pipe", "pipe"] });
    let diagnostic = "";
    child.stdout.resume();
    child.stderr.on("data", data => { diagnostic += String(data); });
    const finished = new Promise<number | null>((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); });
    try {
      let sawLock = false;
      for (let attempt = 0; attempt < 1000 && child.exitCode === null; attempt += 1) {
        try { await readFile(join(f.root, ".git/index.lock")); sawLock = true; break; }
        catch { await pause(2); }
      }
      assert.ok(sawLock, "must interrupt after lock acquisition, not just before startup");
      child.kill("SIGTERM");
      assert.equal(await finished, 2);
      assert.match(diagnostic, /interrupted/);
      assert.deepEqual(await readFile(join(f.root, ".git/index")), before);
      await assert.rejects(readFile(join(f.root, ".git/index.lock")), { code: "ENOENT" });
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });

  it("rejects inherited fork evidence and malformed successful edits", () => {
    assert.throws(() => collectStageFromSession(JSON.stringify({ type: "session", id: "fork", parentSession: "/parent.jsonl" })), /inherited/i);
    assert.throws(() => collectStagePatches([
      event(0, "tool.started", { toolCallId: "e", toolName: "edit", args: { path: "file.txt", edits: [{ oldText: "a", newText: "b" }, {}] } }),
      event(1, "tool.finished", { toolCallId: "e", isError: false }),
    ]), /invalid/i);
  });

  it("serializes competing staging attempts with Git's lock", async () => {
    const f = await fixture();
    await f.stream([patch([{ oldText: "initial", newText: "final" }])]);
    const outcomes = await Promise.allSettled([stageChanges({ input: f.input, cwd: f.root }), stageChanges({ input: f.input, cwd: f.root })]);
    assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(git(f.root, "show", ":file.txt"), "final\nkeep\n");
    await assert.rejects(readFile(join(f.root, ".git/index.lock")), { code: "ENOENT" });
  });

  it("leaves the index byte-identical if private-index preparation fails", async () => {
    const f = await fixture();
    const index = join(f.root, ".git/index");
    const before = await readFile(index);
    await f.stream([patch([{ oldText: "initial", newText: "final" }]), { ...patch([]), path: "other.txt/new.txt", operation: "write", content: "bad parent\n" }]);
    await assert.rejects(stageChanges({ input: f.input, cwd: f.root }), /update-index/i);
    assert.deepEqual(await readFile(index), before);
    await assert.rejects(readFile(join(f.root, ".git/index.lock")), { code: "ENOENT" });
  });

  it("rejects unmerged index entries without resolving them", async () => {
    const f = await fixture();
    const object = git(f.root, "rev-parse", "HEAD:file.txt").trim();
    const update = spawnSync("git", ["-C", f.root, "update-index", "--index-info"], { input: `0 ${"0".repeat(object.length)}\tfile.txt\n100644 ${object} 1\tfile.txt\n100644 ${object} 2\tfile.txt\n`, encoding: "utf8" });
    assert.equal(update.status, 0, update.stderr);
    const before = await readFile(join(f.root, ".git/index"));
    await f.stream([patch([{ oldText: "initial", newText: "final" }])]);
    const report = await stageChanges({ input: f.input, cwd: f.root });
    assert.match(report.conflicts[0]?.reason ?? "", /unmerged/i);
    assert.deepEqual(await readFile(join(f.root, ".git/index")), before);
  });

  it("does not mistake intent-to-add for a staged empty-file write", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "empty.txt"), "");
    git(f.root, "add", "-N", "empty.txt");
    const before = await readFile(join(f.root, ".git/index"));
    await f.stream([{ ...patch([]), operation: "write", path: "empty.txt", content: "" }]);
    const report = await stageChanges({ input: f.input, cwd: f.root });
    assert.ok(report.conflicts.some(c => c.reason.includes("intent-to-add")));
    assert.deepEqual(await readFile(join(f.root, ".git/index")), before);
  });

  it("preserves valid Unicode and a UTF-8 BOM", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "file.txt"), "\ufeffinitial\n\ufffd\n");
    git(f.root, "add", "file.txt");
    git(f.root, "-c", "user.name=Test", "-c", "user.email=test@test", "commit", "-qm", "unicode");
    await f.stream([patch([{ oldText: "initial", newText: "final" }])]);
    assert.deepEqual((await stageChanges({ input: f.input, cwd: f.root })).conflicts, []);
    assert.equal(git(f.root, "show", ":file.txt"), "\ufefffinal\n\ufffd\n");
  });

  it("respects an existing Git lock", async () => {
    const f = await fixture();
    await f.stream([patch([{ oldText: "initial", newText: "final" }])]);
    await writeFile(join(f.root, ".git/index.lock"), "another process");
    await assert.rejects(stageChanges({ input: f.input, cwd: f.root }), /lock/i);
    assert.equal(git(f.root, "diff", "--cached"), "");
    assert.equal(await readFile(join(f.root, ".git/index.lock"), "utf8"), "another process");
  });

  it("handles literal pathspec characters and an unborn repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-unborn-"));
    git(root, "init", "-q");
    const input = join(root, "events.jsonl");
    const events = [event(0, "tool.started", { toolCallId: "w", toolName: "write", args: { path: "[note].txt", content: "new\n" } }), event(1, "tool.finished", { toolCallId: "w", isError: false })];
    await writeFile(input, events.map(e => JSON.stringify(e)).join("\n") + "\n");
    const report = await stageChanges({ input, cwd: root });
    assert.equal(report.conflicts.length, 0);
    assert.equal(git(root, "show", ":[note].txt"), "new\n");
    assert.deepEqual((await stageChanges({ input, cwd: root })).staged, []);
  });
});
