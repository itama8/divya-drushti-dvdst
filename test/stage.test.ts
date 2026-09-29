import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { LiveEvent } from "../src/live/decompose.js";
import {
  collectStageFromSession,
  collectStagePatches,
  detectBashSignals,
  inspectBash,
  planPath,
  stageChanges,
  type StagePatch,
} from "../src/stage/stage.js";

function event(sequence: number, type: string, data: unknown, sessionId = "stage-fixture"): LiveEvent {
  return {
    schemaVersion: 1,
    source: "pi.extension",
    sessionId,
    sequence,
    observedAt: `2026-03-13T10:00:0${sequence}.000Z`,
    type,
    data,
  };
}

function patch(overrides: Partial<StagePatch>): StagePatch {
  return {
    path: "src/app.ts",
    operation: "edit",
    edits: [{ oldText: "old", newText: "new" }],
    content: undefined,
    sourceEventId: "pi.extension:stage-fixture:0",
    resultEventId: "pi.extension:stage-fixture:1",
    ...overrides,
  };
}

function sessionLine(entry: unknown): string {
  return `${JSON.stringify(entry)}\n`;
}

function git(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dvdst-stage-"));
  git(root, ["init", "-q"]);
  return root;
}

async function commitBaseline(root: string, message = "baseline"): Promise<void> {
  git(root, ["add", "-A"]);
  const committed = spawnSync("git", ["-C", root, "-c", "user.email=test@test", "-c", "user.name=test", "commit", "-qm", message], { encoding: "utf8" });
  assert.equal(committed.status, 0, committed.stderr);
}

describe("stage mutation collection", () => {
  it("keeps successful edit and write calls, skips failed calls, and records bash candidates", () => {
    const collected = collectStagePatches([
      event(0, "session.started", { cwd: "/repo" }),
      event(1, "tool.started", { toolCallId: "e1", toolName: "edit", args: { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] } }),
      event(2, "tool.finished", { toolCallId: "e1", isError: false }),
      event(3, "tool.started", { toolCallId: "e2", toolName: "edit", args: { path: "src/b.ts", edits: [{ oldText: "c", newText: "d" }] } }),
      event(4, "tool.finished", { toolCallId: "e2", isError: true }),
      event(5, "tool.started", { toolCallId: "w1", toolName: "write", args: { path: "src/c.ts", content: "hello\n" } }),
      event(6, "tool.finished", { toolCallId: "w1", isError: false }),
      event(7, "tool.started", { toolCallId: "b1", toolName: "bash", args: { command: "cat >> src/d.ts <<'EOF'" } }),
      event(8, "tool.finished", { toolCallId: "b1", isError: false }),
    ]);
    assert.equal(collected.sessionId, "stage-fixture");
    assert.equal(collected.cwd, "/repo");
    assert.deepEqual(collected.patches.map((entry) => [entry.path, entry.operation]), [
      ["src/a.ts", "edit"],
      ["src/c.ts", "write"],
    ]);
    assert.equal(collected.patches[1]!.content, "hello\n");
    assert.deepEqual(collected.bash.map((entry) => entry.command), ["cat >> src/d.ts <<'EOF'"]);
  });
});

describe("bash mutation signals", () => {
  it("flags commands that can change files", () => {
    assert.deepEqual(detectBashSignals("cat >> src/util.ts <<'EOF'"), ["heredoc", "redirect"]);
    assert.ok(detectBashSignals("git apply --cached /tmp/x.patch").includes("git apply or patch"));
    assert.ok(detectBashSignals("sed -i 's/a/b/' src/a.ts").includes("in-place edit"));
    assert.ok(detectBashSignals("python3 - <<'PY'\nopen('x','w')\nPY").includes("inline script"));
    assert.ok(detectBashSignals("node -e \"require('fs').writeFileSync('x','y')\"").includes("inline script"));
    assert.ok(detectBashSignals("npm install left-pad").includes("package install"));
  });

  it("stays quiet on read-only commands", () => {
    for (const command of [
      "git status --short",
      "git diff --stat",
      "rg -n 'starter note' docs/plans/checkpoint-map.md",
      "ls -la experiments",
      "mkdir -p experiments/playground/starter-notes",
      "node scripts/devlog-contract.mjs",
      "notesmd-cli list --vault my-vault",
      "wc -w experiments/playground/starter-notes/*.md",
      "command -v notesmd-cli",
      "2>&1 | tail -5",
    ]) {
      assert.deepEqual(detectBashSignals(command), [], command);
    }
  });

  it("ranks content writers above temporary-file cleanup", () => {
    const ranked = inspectBash([
      { command: "rm -f /tmp/hud.png", toolCallId: "b1", sourceEventId: "s1" },
      { command: "git apply --cached /tmp/x.patch", toolCallId: "b2", sourceEventId: "s2" },
      { command: "cat >> src/util.ts <<'EOF'", toolCallId: "b3", sourceEventId: "s3" },
    ]);
    assert.deepEqual(ranked.map((entry) => entry.toolCallId), ["b2", "b3", "b1"]);
    assert.deepEqual(ranked[0]!.signals, ["git apply or patch"]);
  });
});

describe("stage session file collection", () => {
  it("pairs tool calls with results and keeps only confirmed successes", () => {
    const text = [
      sessionLine({ type: "session", version: 3, id: "sess-1", timestamp: "2026-09-29T15:10:58.084Z", cwd: "/repo" }),
      sessionLine({
        type: "message",
        id: "a1",
        message: { role: "assistant", content: [
          { type: "toolCall", id: "c1", name: "write", arguments: { path: "notes/a.md", content: "# A\n" } },
          { type: "toolCall", id: "c2", name: "edit", arguments: { path: "notes/a.md", edits: [{ oldText: "# A", newText: "# A v2" }] } },
          { type: "toolCall", id: "c3", name: "bash", arguments: { command: "cat >> notes/b.md <<'EOF'\nhi\nEOF" } },
          { type: "toolCall", id: "c4", name: "write", arguments: { path: "notes/failed.md", content: "no\n" } },
        ] },
      }),
      sessionLine({ type: "message", id: "r1", message: { role: "toolResult", toolCallId: "c1", toolName: "write", content: [], isError: false } }),
      sessionLine({ type: "message", id: "r2", message: { role: "toolResult", toolCallId: "c2", toolName: "edit", content: [], isError: false } }),
      sessionLine({ type: "message", id: "r3", message: { role: "toolResult", toolCallId: "c3", toolName: "bash", content: [], isError: false } }),
      sessionLine({ type: "message", id: "r4", message: { role: "toolResult", toolCallId: "c4", toolName: "write", content: [], isError: true } }),
    ].join("");
    const collected = collectStageFromSession(text);
    assert.equal(collected.sessionId, "sess-1");
    assert.equal(collected.cwd, "/repo");
    assert.deepEqual(collected.patches.map((entry) => [entry.path, entry.operation]), [
      ["notes/a.md", "write"],
      ["notes/a.md", "edit"],
    ]);
    assert.deepEqual(collected.bash.map((entry) => entry.toolCallId), ["c3"]);
  });
});

describe("stage path planning", () => {
  it("applies exact anchors and leaves other content alone", () => {
    const plan = planPath("one\ntwo\nthree\n", [patch({ edits: [{ oldText: "two", newText: "TWO" }] })]);
    assert.deepEqual(plan, { status: "staged", content: "one\nTWO\nthree\n", operation: "edit", hunks: 1 });
  });

  it("reports a conflict when the anchor is missing", () => {
    const plan = planPath("one\ntwo\n", [patch({ edits: [{ oldText: "absent", newText: "x" }] })]);
    assert.equal(plan.status, "conflict");
  });

  it("reports a conflict when the anchor is not unique", () => {
    const plan = planPath("same\nsame\n", [patch({ edits: [{ oldText: "same", newText: "other" }] })]);
    assert.equal(plan.status, "conflict");
  });

  it("does not infer replay from replacement text alone", () => {
    const plan = planPath("one\nTWO\n", [patch({ edits: [{ oldText: "two", newText: "TWO" }] })]);
    assert.equal(plan.status, "conflict");
  });

  it("stages a new file from a write call", () => {
    const plan = planPath(undefined, [patch({ operation: "write", edits: [], content: "new file\n" })]);
    assert.deepEqual(plan, { status: "staged", content: "new file\n", operation: "write", hunks: 1 });
  });

  it("applies an edit after a write created the file", () => {
    const plan = planPath(undefined, [
      patch({ operation: "write", edits: [], content: "# A\n" }),
      patch({ sourceEventId: "pi.extension:stage-fixture:2", edits: [{ oldText: "# A", newText: "# A v2" }] }),
    ]);
    assert.deepEqual(plan, { status: "staged", content: "# A v2\n", operation: "write", hunks: 2 });
  });

  it("refuses to edit a file that is not tracked and was not written", () => {
    const plan = planPath(undefined, [patch({})]);
    assert.equal(plan.status, "conflict");
  });
});

describe("stage live stream", () => {
  it("stages only the session's anchored change and leaves a dirty hunk unstaged", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-stage-"));
    git(root, ["init", "-q"]);
    await mkdir(join(root, "src"), { recursive: true });
    const baseline = "export function greeting(name: string): string {\n  return `Hello, ${name}`;\n}\n\nexport function topLabel(count: number): string {\n  return `${count} items`;\n}\n";
    await writeFile(join(root, "src/app.ts"), baseline);
    await commitBaseline(root);

    // The session edit and another writer's dirty change both sit in the worktree.
    await writeFile(join(root, "src/app.ts"), baseline.replace("`${count} items`", "`${count} entries`").replace("Hello,", "Hi,"));

    const stream = join(root, "live.jsonl");
    const events = [
      event(0, "session.started", { cwd: root }),
      event(1, "tool.started", { toolCallId: "e1", toolName: "edit", args: { path: "src/app.ts", edits: [{ oldText: "  return `Hello, ${name}`;", newText: "  return `Hi, ${name}`;" }] } }),
      event(2, "tool.finished", { toolCallId: "e1", isError: false }),
      event(3, "agent.settled", {}),
    ];
    await writeFile(stream, `${events.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    const report = await stageChanges({ input: stream, cwd: root });
    assert.deepEqual(report.conflicts, []);
    assert.deepEqual(report.staged, [{ path: "src/app.ts", operation: "edit", hunks: 1 }]);
    assert.deepEqual(report.unattributedBash, []);

    const indexed = git(root, ["show", ":src/app.ts"]);
    assert.match(indexed.stdout, /return `Hi, \$\{name\}`;/);
    assert.doesNotMatch(indexed.stdout, /entries/);
    assert.equal(git(root, ["diff", "--cached", "--name-only"]).stdout.trim(), "src/app.ts");

    const worktree = git(root, ["diff"]).stdout;
    assert.match(worktree, /entries/);
    assert.doesNotMatch(worktree, /Hi, \$\{name\}/);

    const repeated = await stageChanges({ input: stream, cwd: root });
    assert.deepEqual(repeated.staged, []);
    assert.deepEqual(repeated.unchanged, ["src/app.ts"]);
    assert.equal(await readFile(join(root, "src/app.ts"), "utf8"), baseline.replace("`${count} items`", "`${count} entries`").replace("Hello,", "Hi,"));
  });

  it("supports a dry run without touching the index", async () => {
    const root = await initRepo();
    await writeFile(join(root, "file.txt"), "before\n");
    await commitBaseline(root);
    const stream = join(root, "live.jsonl");
    const events = [
      event(0, "session.started", { cwd: root }),
      event(1, "tool.started", { toolCallId: "e1", toolName: "edit", args: { path: "file.txt", edits: [{ oldText: "before", newText: "after" }] } }),
      event(2, "tool.finished", { toolCallId: "e1", isError: false }),
    ];
    await writeFile(stream, `${events.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    const report = await stageChanges({ input: stream, cwd: root, dryRun: true });
    assert.equal(report.dryRun, true);
    assert.deepEqual(report.staged, [{ path: "file.txt", operation: "edit", hunks: 1 }]);
    assert.equal(git(root, ["show", ":file.txt"]).stdout, "before\n");
    assert.equal(git(root, ["diff", "--cached", "--name-only"]).stdout, "");
  });
});

describe("stage session file", () => {
  it("stages confirmed writes and warns about bash content changes it did not stage", async () => {
    const root = await initRepo();
    await writeFile(join(root, "README.md"), "# repo\n");
    await commitBaseline(root);

    const session = join(root, "session.jsonl");
    const text = [
      sessionLine({ type: "session", version: 3, id: "sess-2", timestamp: "2026-09-29T15:10:58.084Z", cwd: root }),
      sessionLine({
        type: "message",
        id: "a1",
        message: { role: "assistant", content: [
          { type: "toolCall", id: "c1", name: "write", arguments: { path: "notes/new.md", content: "# New\n" } },
          { type: "toolCall", id: "c2", name: "bash", arguments: { command: "cat >> notes/new.md <<'EOF'\nmore\nEOF" } },
          { type: "toolCall", id: "c3", name: "bash", arguments: { command: "git status --short" } },
        ] },
      }),
      sessionLine({ type: "message", id: "r1", message: { role: "toolResult", toolCallId: "c1", toolName: "write", content: [], isError: false } }),
      sessionLine({ type: "message", id: "r2", message: { role: "toolResult", toolCallId: "c2", toolName: "bash", content: [], isError: false } }),
      sessionLine({ type: "message", id: "r3", message: { role: "toolResult", toolCallId: "c3", toolName: "bash", content: [], isError: false } }),
    ].join("");
    await writeFile(session, text);

    const report = await stageChanges({ sessionFile: session, cwd: root });
    assert.equal(report.source, "session-file");
    assert.equal(report.sessionId, "sess-2");
    assert.deepEqual(report.staged, [{ path: "notes/new.md", operation: "write", hunks: 1 }]);
    assert.equal(report.unattributedBashCount, 1);
    assert.deepEqual(report.unattributedBash[0]!.signals, ["heredoc", "redirect"]);
    assert.match(report.unattributedBash[0]!.command, /cat >> notes\/new\.md/);
    assert.equal(git(root, ["show", ":notes/new.md"]).stdout, "# New\n");
  });
});
