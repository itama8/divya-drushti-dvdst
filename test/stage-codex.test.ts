import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { collectStageFromSession, stageChanges } from "../src/stage/stage.js";

const add = "*** Begin Patch\n*** Add File: new.txt\n+created\n*** End Patch";
const edit = "*** Begin Patch\n*** Update File: file.txt\n@@\n-base\n+changed\n other\n*** End Patch";
const line = (type: string, payload: unknown) => JSON.stringify({ type, payload });
function rollout(cwd: string, entries: string[], extra = {}) {
  return [line("session_meta", { id: "codex-1", cwd, ...extra }), ...entries].join("\n") + "\n";
}
function call(id: string, patch: string, wrapper = false): string {
  return line("response_item", { type: "custom_tool_call", call_id: id, name: wrapper ? "exec" : "apply_patch", input: wrapper ? `text(await tools.apply_patch(${JSON.stringify(patch)}));` : patch });
}
function result(id: string, success = true, wrapper = false): string {
  return line("response_item", { type: "custom_tool_call_output", call_id: id,
    output: wrapper ? [{ type: "input_text", text: success ? "Script completed\nWall time 0.0 seconds\nOutput:\n" : "Script failed\nOutput:\n" }, { type: "input_text", text: success ? "{}" : "apply_patch verification failed" }]
      : JSON.stringify({ output: success ? "Success. Updated the following files:\nM file.txt\n" : "Failed to find expected lines", metadata: { exit_code: success ? 0 : 1 } }),
  });
}
function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
async function fixture(run: (root: string, file: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "dvdst-codex-"));
  try {
    git(root, "init", "-q"); git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@test");
    await writeFile(join(root, "file.txt"), "base\nother\n");
    git(root, "add", "."); git(root, "commit", "-qm", "base");
    await run(root, join(root, "rollout.jsonl"));
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe("Codex session staging", () => {
  it("selects complete recorded files explicitly and reports omitted siblings without staging stale content", async () => fixture(async (root, file) => {
    const multi = edit.replace("*** End Patch", "*** Add File: stale.txt\n+obsolete payload\n*** End Patch");
    await writeFile(file, rollout(root, [call("multi", multi), result("multi")]));
    await writeFile(join(root, "stale.txt"), "another writer's current content\n");
    const manifest = join(root, "selection.json");
    await writeFile(manifest, JSON.stringify({ schemaVersion: 1, head: git(root, "rev-parse", "HEAD").trim(), sources: [{ kind: "session-file", path: file, sessionId: "codex-1" }], mutations: [{ sessionId: "codex-1", resultEventId: "codex:result:multi", paths: [join(root, "file.txt")] }] }));
    const report = await stageChanges({ manifest, cwd: root, session: "caller" });
    assert.deepEqual(report.conflicts, []); assert.equal(report.staged.length, 1);
    assert.deepEqual(report.selection!.omitted, [{ sessionId: "codex-1", resultEventId: "codex:result:multi", path: join(root, "stale.txt") }]);
    assert.equal(git(root, "ls-files", "stale.txt"), "");
    assert.equal(await readFile(join(root, "stale.txt"), "utf8"), "another writer's current content\n");
  }));

  it("explicit file selection can scope a cross-repository call while whole-call defaults and selected outside paths still block", async () => fixture(async (root, file) => {
    const outside = join(root, "..", "outside-recorded.txt");
    const multi = edit.replace("*** End Patch", `*** Add File: ${outside}\n+outside\n*** End Patch`);
    await writeFile(file, rollout(root, [call("multi", multi), result("multi")]));
    const manifest = join(root, "selection.json");
    const value = { schemaVersion: 1, head: git(root, "rev-parse", "HEAD").trim(), sources: [{ kind: "session-file", path: file, sessionId: "codex-1" }], mutations: [{ sessionId: "codex-1", resultEventId: "codex:result:multi" }] };
    await writeFile(manifest, JSON.stringify(value));
    assert.match((await stageChanges({ manifest, cwd: root, session: "caller" })).conflicts[0]!.reason, /outside/);
    await writeFile(manifest, JSON.stringify({ ...value, mutations: [{ ...value.mutations[0], paths: [join(root, "file.txt")] }] }));
    const report = await stageChanges({ manifest, cwd: root, session: "caller" });
    assert.deepEqual(report.conflicts, []); assert.equal(report.selection!.omitted![0]!.path, outside);
    const before = await readFile(join(root, ".git/index"));
    await writeFile(manifest, JSON.stringify({ ...value, mutations: [{ ...value.mutations[0], paths: [outside] }] }));
    assert.match((await stageChanges({ manifest, cwd: root, session: "caller" })).conflicts[0]!.reason, /outside/);
    assert.deepEqual(await readFile(join(root, ".git/index")), before);
  }));

  it("refuses empty, unknown, relative, and duplicate recorded file selectors", async () => fixture(async (root, file) => {
    await writeFile(file, rollout(root, [call("edit", edit), result("edit")]));
    const manifest = join(root, "selection.json");
    const value = { schemaVersion: 1, head: git(root, "rev-parse", "HEAD").trim(), sources: [{ kind: "session-file", path: file, sessionId: "codex-1" }] };
    const before = await readFile(join(root, ".git/index"));
    for (const paths of [[], [join(root, "unknown")], ["file.txt"], [join(root, "file.txt"), join(root, "file.txt")]]) {
      await writeFile(manifest, JSON.stringify({ ...value, mutations: [{ sessionId: "codex-1", resultEventId: "codex:result:edit", paths }] }));
      await assert.rejects(stageChanges({ manifest, cwd: root, session: "caller" }), /paths|path/);
      assert.deepEqual(await readFile(join(root, ".git/index")), before);
    }
  }));

  it("uses a unique recorded locator before a repeated closing line without a global substring guess", async () => fixture(async (root, file) => {
    const baseline = "first\n});\nsecond\n});\nthird\n});\n";
    await writeFile(join(root, "file.txt"), baseline); git(root, "add", "file.txt"); git(root, "commit", "-qm", "repeated closing lines");
    const input = "*** Begin Patch\n*** Update File: file.txt\n@@\n second\n@@\n });\n+inserted\n*** End Patch";
    await writeFile(file, rollout(root, [call("ordered", input), result("ordered")]));
    assert.deepEqual((await stageChanges({ sessionFile: file, cwd: root })).conflicts, []);
    assert.equal(git(root, "show", ":file.txt"), "first\n});\nsecond\n});\ninserted\nthird\n});\n");
  }));

  it("validates and replays context-only hunks preceding a replacement", async () => fixture(async (root, file) => {
    const input = "*** Begin Patch\n*** Update File: file.txt\n@@\n base\n@@\n-other\n+changed\n*** End Patch";
    await writeFile(file, rollout(root, [call("context", input), result("context")]));
    const report = await stageChanges({ sessionFile: file, cwd: root });
    assert.deepEqual(report.conflicts, []);
    assert.equal(git(root, "show", ":file.txt"), "base\nchanged\n");
  }));

  it("pairs native and strict exec patches; excludes failures, pending calls, and arbitrary wrappers", () => {
    const text = rollout("/repo", [call("native", add), result("native"), call("wrapped", edit, true), result("wrapped", true, true),
      call("failed", add), result("failed", false), call("pending", add), call("failed-wrapper", add, true), result("failed-wrapper", false, true),
      line("response_item", { type: "custom_tool_call", call_id: "arbitrary", name: "exec", input: `try { text(await tools.apply_patch(${JSON.stringify(add)})); } catch {}` }), result("arbitrary", true, true)]);
    const collected = collectStageFromSession(text);
    assert.equal(collected.sessionId, "codex-1");
    assert.deepEqual(collected.patches.map(patch => [patch.path, patch.resultEventId]), [["/repo/new.txt", "codex:result:native"], ["/repo/file.txt", "codex:result:wrapped"]]);
    assert.equal(collected.bash.length, 1);
  });

  it("uses each call's recorded cwd and refuses forks, duplicate results, and unsupported successful operations", () => {
    const entries = [line("turn_context", { cwd: "/repo/sub" }), call("a", add), result("a")];
    assert.equal(collectStageFromSession(rollout("/repo", entries)).patches[0]!.path, "/repo/sub/new.txt");
    assert.throws(() => collectStageFromSession(rollout("/repo", entries, { forked_from_id: "parent" })), /forked/);
    assert.throws(() => collectStageFromSession(rollout("/repo", entries, { history_base: {} })), /pagination loading/);
    assert.throws(() => collectStageFromSession(rollout("/repo", [...entries, result("a")])), /duplicate/);
    assert.throws(() => collectStageFromSession(rollout("/repo", [call("a", "*** Begin Patch\n*** Delete File: file.txt\n*** End Patch"), result("a")])), /deletes and moves/);
  });

  it("does not match a line hunk to a suffix inside a longer line", async () => fixture(async (root, file) => {
    await writeFile(join(root, "file.txt"), "database\nother\n"); git(root, "add", "file.txt"); git(root, "commit", "-qm", "line suffix");
    await writeFile(file, rollout(root, [call("a", edit), result("a")]));
    const before = await readFile(join(root, ".git/index"));
    assert.match((await stageChanges({ sessionFile: file, cwd: root })).conflicts[0]!.reason, /line boundary/);
    assert.deepEqual(await readFile(join(root, ".git/index")), before);
  }));

  it("honors the explicit end-of-file marker instead of applying it to an interior hunk", async () => fixture(async (root, file) => {
    await writeFile(join(root, "file.txt"), "base\nother\ntrailing\n"); git(root, "add", "file.txt"); git(root, "commit", "-qm", "trailing line");
    await writeFile(file, rollout(root, [call("a", edit.replace("*** End Patch", "*** End of File\n*** End Patch")), result("a")]));
    assert.match((await stageChanges({ sessionFile: file, cwd: root })).conflicts[0]!.reason, /EOF/);
  }));

  it("stages exact session hunks, preserves foreign dirty content, supports dry runs and repeated staging", async () => fixture(async (root, file) => {
    await writeFile(join(root, "file.txt"), "changed\nother\nforeign\n");
    await writeFile(file, rollout(root, [call("a", edit, true), result("a", true, true)]));
    const before = await readFile(join(root, ".git/index"));
    assert.deepEqual((await stageChanges({ sessionFile: file, cwd: root, dryRun: true })).conflicts, []);
    assert.deepEqual(await readFile(join(root, ".git/index")), before);
    const report = await stageChanges({ sessionFile: file, cwd: root });
    assert.deepEqual(report.conflicts, []);
    assert.equal(git(root, "show", ":file.txt"), "changed\nother\n");
    assert.equal(await readFile(join(root, "file.txt"), "utf8"), "changed\nother\nforeign\n");
    assert.deepEqual((await stageChanges({ sessionFile: file, cwd: root })).unchanged, ["file.txt"]);
  }));

  it("keeps foreign staged bytes intact and refuses ambiguous anchors", async () => fixture(async (root, file) => {
    await writeFile(join(root, "foreign.txt"), "foreign\n"); git(root, "add", "foreign.txt");
    const before = await readFile(join(root, ".git/index"));
    await writeFile(file, rollout(root, [call("a", edit), result("a")]));
    assert.match((await stageChanges({ sessionFile: file, cwd: root })).conflicts[0]!.reason, /unrelated/);
    assert.deepEqual(await readFile(join(root, ".git/index")), before);
    git(root, "reset", "-q", "HEAD", "--", "foreign.txt");
    await writeFile(join(root, "file.txt"), "base\nother\nbase\nother\n"); git(root, "add", "file.txt"); git(root, "commit", "-qm", "repeat");
    assert.match((await stageChanges({ sessionFile: file, cwd: root })).conflicts[0]!.reason, /not unique/);
  }));

  it("continues the same session after a committed result, without guessing or accepting unknown cursors", async () => fixture(async (root, file) => {
    await writeFile(file, rollout(root, [call("a", edit), result("a")]));
    await stageChanges({ sessionFile: file, cwd: root }); git(root, "commit", "-qm", "first");
    const second = edit.replace("-base\n+changed", "-changed\n+later");
    await writeFile(file, rollout(root, [call("a", edit), result("a"), call("b", second), result("b")]));
    const report = await stageChanges({ sessionFile: file, cwd: root, after: "codex:result:a" });
    assert.deepEqual(report.conflicts, []); assert.equal(git(root, "show", ":file.txt"), "later\nother\n");
    await assert.rejects(stageChanges({ sessionFile: file, cwd: root, after: "missing" }), /successful mutation/);
  }));

  it("a manifest selects the complete multi-file call exactly once", async () => fixture(async (root, file) => {
    const multi = edit.replace("*** End Patch", "*** Add File: new.txt\n+created\n*** End Patch");
    await writeFile(file, rollout(root, [call("multi", multi), result("multi")]));
    const manifest = join(root, "selection.json");
    const value = { schemaVersion: 1, head: git(root, "rev-parse", "HEAD").trim(), sources: [{ kind: "session-file", path: file, sessionId: "codex-1" }], mutations: [{ sessionId: "codex-1", resultEventId: "codex:result:multi" }] };
    await writeFile(manifest, JSON.stringify(value));
    const report = await stageChanges({ manifest, session: "caller", cwd: root });
    assert.deepEqual(report.conflicts, []); assert.equal(report.staged.length, 2); assert.equal(report.selection!.mutations.length, 2);
    await writeFile(manifest, JSON.stringify({ ...value, mutations: [...value.mutations, ...value.mutations] }));
    await assert.rejects(stageChanges({ manifest, session: "caller", cwd: root }), /duplicate/);
  }));

  it("replays dependent Claude and Codex changes in explicit manifest order", async () => fixture(async (root, file) => {
    const claude = join(root, "claude.jsonl");
    await writeFile(claude, [
      JSON.stringify({ type: "assistant", uuid: "a", sessionId: "claude-1", cwd: root, message: { id: "m", role: "assistant", content: [{ type: "tool_use", id: "t", name: "Edit", input: { file_path: join(root, "file.txt"), old_string: "base", new_string: "changed" } }] } }),
      JSON.stringify({ type: "user", uuid: "r", sessionId: "claude-1", cwd: root, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } }),
    ].join("\n"));
    await writeFile(file, rollout(root, [call("codex", edit.replace("-base\n+changed", "-changed\n+later")), result("codex")]));
    const manifest = join(root, "mixed.json");
    const value = { schemaVersion: 1, head: git(root, "rev-parse", "HEAD").trim(), sources: [{ kind: "session-file", path: claude, sessionId: "claude-1" }, { kind: "session-file", path: file, sessionId: "codex-1" }], mutations: [{ sessionId: "claude-1", resultEventId: "r:0" }, { sessionId: "codex-1", resultEventId: "codex:result:codex" }] };
    await writeFile(manifest, JSON.stringify(value));
    const report = await stageChanges({ manifest, session: "caller", cwd: root });
    assert.deepEqual(report.conflicts, []); assert.equal(git(root, "show", ":file.txt"), "later\nother\n");
    git(root, "reset", "-q", "HEAD", "--", "file.txt");
    await writeFile(manifest, JSON.stringify({ ...value, mutations: [...value.mutations].reverse() }));
    const before = await readFile(join(root, ".git/index"));
    assert.match((await stageChanges({ manifest, session: "caller", cwd: root })).conflicts[0]!.reason, /not found/);
    assert.deepEqual(await readFile(join(root, ".git/index")), before);
  }));
});
