import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { collectStageFromSession, normalizeEditArguments } from "../src/stage/stage.js";

// Synthetic Pi session entries: a `session` header, assistant `toolCall`
// blocks, and `toolResult` messages, matching Pi's recorded shape.
type Call = { id: string; name: string; arguments: Record<string, unknown> };
const header = (id: string, cwd: string, extra = {}) => ({ type: "session", version: 3, id, timestamp: "2026-11-01T10:00:00.000Z", cwd, ...extra });
const assistant = (id: string, calls: Call[]) => ({ type: "message", id, parentId: null, message: { role: "assistant", content: calls.map(call => ({ type: "toolCall", ...call })) } });
const result = (id: string, toolCallId: string, isError = false) => ({ type: "message", id, parentId: null, message: { role: "toolResult", toolCallId, toolName: "edit", content: [{ type: "text", text: isError ? "Could not edit" : "ok" }], isError } });
const jsonl = (entries: unknown[]) => entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
const edit = (id: string, path: string, oldText: string, newText: string): Call => ({ id, name: "edit", arguments: { path, edits: [{ oldText, newText }] } });
const write = (id: string, path: string, content: string): Call => ({ id, name: "write", arguments: { path, content } });

function git(root: string, ...args: string[]): string {
  const run = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

const cli = new URL("../src/cli/session-stage.ts", import.meta.url).pathname;
function stage(args: string[], env: Record<string, string> = {}, cwd = process.cwd()) {
  // Tests may run inside a Pi session; never inherit the caller's identity.
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PI_SESSION_|PI_CODING_AGENT_|CLAUDE_CODE_SESSION_ID|CODEX_THREAD_ID)/.test(key)));
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { encoding: "utf8", cwd, env: { ...base, ...env } });
}

async function repo(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "dvdst-pi-stage-"));
  try {
    git(root, "init", "-q"); git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@test");
    await writeFile(join(root, "app.txt"), "alpha\nbeta\ngamma\n");
    git(root, "add", "."); git(root, "commit", "-qm", "base");
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

/** One session: a successful edit, write, legacy-shape edit, failed edit, unfinished write, and a mutating bash call. */
function session(root: string, id = "pi-session-1") {
  return jsonl([
    header(id, root),
    assistant("a1", [edit("c1", "app.txt", "alpha\n", "ALPHA\n"), write("c2", "notes/new.md", "# New\n")]),
    result("r1", "c1"), result("r2", "c2"),
    // Pi applies the legacy top-level oldText/newText form; staging normalizes it the same way.
    assistant("a2", [{ id: "c3", name: "edit", arguments: { path: "app.txt", oldText: "beta\n", newText: "BETA\n" } }]),
    result("r3", "c3"),
    assistant("a3", [edit("c4", "app.txt", "missing\n", "never\n"), write("c5", "notes/unfinished.md", "no result\n"), { id: "c6", name: "bash", arguments: { command: "printf x > shell.txt" } }]),
    result("r4", "c4", true), result("r6", "c6"),
  ]);
}

describe("Pi argument normalization", () => {
  it("mirrors Pi's prepareEditArguments for recorded raw arguments", () => {
    const pair = { oldText: "a", newText: "b" };
    assert.deepEqual(normalizeEditArguments({ path: "f", edits: [pair] }), { path: "f", edits: [pair] });
    assert.deepEqual(normalizeEditArguments({ path: "f", edits: JSON.stringify([pair]) }), { path: "f", edits: [pair] });
    assert.deepEqual(normalizeEditArguments({ path: "f", edits: JSON.stringify(pair) }), { path: "f", edits: [pair] });
    assert.deepEqual(normalizeEditArguments({ path: "f", edits: pair }), { path: "f", edits: [pair] });
    assert.deepEqual(normalizeEditArguments({ path: "f", ...pair }), { path: "f", edits: [pair] });
    assert.deepEqual(normalizeEditArguments({ path: "f", edits: [pair], oldText: "c", newText: "d" }), { path: "f", edits: [pair, { oldText: "c", newText: "d" }] });
    // Unparseable strings stay as recorded and are refused by validation.
    assert.deepEqual(normalizeEditArguments({ path: "f", edits: "not json" }), { path: "f", edits: "not json" });
  });

  it("collects only confirmed successes in result order", () => {
    const collected = collectStageFromSession(session("/repo"));
    assert.equal(collected.agent, "pi");
    assert.deepEqual(collected.patches.map(patch => [patch.resultEventId, patch.operation, patch.path]), [
      ["r1", "edit", "app.txt"], ["r2", "write", "notes/new.md"], ["r3", "edit", "app.txt"],
    ]);
    assert.deepEqual(collected.bash.map(call => call.toolCallId), ["c6"]);
  });

  it("refuses forked Pi session files that carry inherited mutations", () => {
    assert.throws(() => collectStageFromSession(jsonl([header("fork", "/repo", { parentSession: "/sessions/parent.jsonl" })])), /forked session/);
  });
});

describe("dvdst session-stage --agent pi", () => {
  it("lists successful edit/write selectors and warns that bash edits are unattributed", async () => repo(async root => {
    const file = join(root, "session.jsonl");
    await writeFile(file, session(root));
    const listed = stage(["--agent", "pi", "--session-file", file, "--list"]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(listed.stdout.trim().split("\n").map(line => JSON.parse(line)), [
      { sessionId: "pi-session-1", resultEventId: "r1", operation: "edit", path: "app.txt" },
      { sessionId: "pi-session-1", resultEventId: "r2", operation: "write", path: "notes/new.md" },
      { sessionId: "pi-session-1", resultEventId: "r3", operation: "edit", path: "app.txt" },
    ]);
    assert.match(listed.stderr, /1 successful bash command\(s\) look file-mutating; bash edits are never attributed/);
    const after = stage(["--agent", "pi", "--session-file", file, "--list", "--after", "r2"]);
    assert.deepEqual(after.stdout.trim().split("\n").map(line => JSON.parse(line).resultEventId), ["r3"]);
  }));

  it("stages exact replays into the index only, leaving failed, unfinished, bash, and unrelated unstaged work alone", async () => repo(async root => {
    const file = join(root, "session.jsonl");
    await writeFile(file, session(root));
    await writeFile(join(root, "app.txt"), "ALPHA\nBETA\ngamma\nforeign unstaged line\n");
    await mkdir(join(root, "notes"));
    await writeFile(join(root, "notes/new.md"), "# New\n");
    await writeFile(join(root, "shell.txt"), "x");
    const dry = stage(["--agent", "pi", "--session-file", file, "--repository", root, "--dry-run"]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(git(root, "diff", "--cached", "--name-only"), "");
    const run = stage(["--agent", "pi", "--session-file", file, "--repository", root]);
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.deepEqual(report.staged, [{ path: "app.txt", operation: "edit", hunks: 2 }, { path: "notes/new.md", operation: "write", hunks: 1 }]);
    assert.equal(report.unattributedBashCount, 1);
    assert.match(run.stderr, /Staged 2 file\(s\).*bash edits are never attributed/);
    assert.equal(git(root, "show", ":app.txt"), "ALPHA\nBETA\ngamma\n");
    assert.equal(git(root, "ls-files", "notes/unfinished.md", "shell.txt"), "");
    assert.match(git(root, "diff"), /\+foreign unstaged line/);
    // Re-running is an exact replay of the index state, not a new change.
    const again = JSON.parse(stage(["--agent", "pi", "--session-file", file, "--repository", root]).stdout);
    assert.deepEqual(again.staged, []); assert.deepEqual(again.unchanged.sort(), ["app.txt", "notes/new.md"]);
  }));

  it("blocks conflicts with the index unchanged", async () => repo(async root => {
    const file = join(root, "session.jsonl");
    // HEAD no longer holds the recorded anchor.
    await writeFile(file, jsonl([header("pi-conflict", root), assistant("a1", [edit("c1", "app.txt", "delta\n", "DELTA\n")]), result("r1", "c1")]));
    const before = await readFile(join(root, ".git/index"));
    const run = stage(["--agent", "pi", "--session-file", file, "--repository", root]);
    assert.equal(run.status, 1);
    assert.match(JSON.parse(run.stdout).conflicts[0].reason, /anchor was not found/);
    assert.match(run.stderr, /index was not changed/);
    assert.deepEqual(await readFile(join(root, ".git/index")), before);
    // Whole-file writes to tracked paths and foreign staged work also block.
    await writeFile(file, jsonl([header("pi-write", root), assistant("a1", [write("c1", "app.txt", "replaced\n")]), result("r1", "c1")]));
    assert.match(JSON.parse(stage(["--agent", "pi", "--session-file", file, "--repository", root]).stdout).conflicts[0].reason, /whole-file write to a tracked file/);
    await writeFile(file, session(root));
    await writeFile(join(root, "foreign.txt"), "foreign\n"); git(root, "add", "foreign.txt");
    const staged = await readFile(join(root, ".git/index"));
    const blocked = stage(["--agent", "pi", "--session-file", file, "--repository", root]);
    assert.equal(blocked.status, 1);
    assert.ok(JSON.parse(blocked.stdout).conflicts.some((issue: { reason: string }) => /unrelated changes are already staged/.test(issue.reason)));
    assert.deepEqual(await readFile(join(root, ".git/index")), staged);
  }));

  it("continues after a committed cursor", async () => repo(async root => {
    const file = join(root, "session.jsonl");
    await writeFile(file, session(root));
    // Commit the first two mutations, then stage only what followed.
    await writeFile(join(root, "app.txt"), "ALPHA\nbeta\ngamma\n");
    await mkdir(join(root, "notes")); await writeFile(join(root, "notes/new.md"), "# New\n");
    git(root, "add", "."); git(root, "commit", "-qm", "first two");
    const stale = stage(["--agent", "pi", "--session-file", file, "--repository", root, "--dry-run"]);
    assert.equal(stale.status, 1);
    const run = stage(["--agent", "pi", "--session-file", file, "--repository", root, "--after", "r2"]);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout).staged, [{ path: "app.txt", operation: "edit", hunks: 1 }]);
    assert.equal(git(root, "show", ":app.txt"), "ALPHA\nBETA\ngamma\n");
    assert.match(stage(["--agent", "pi", "--session-file", file, "--repository", root, "--after", "unknown"]).stderr, /--after must identify/);
  }));

  it("stages an interleaved manifest across two Pi sessions with the caller identity from PI_SESSION_ID", async () => repo(async root => {
    const one = join(root, "one.jsonl"), two = join(root, "two.jsonl");
    await writeFile(one, jsonl([header("pi-one", root), assistant("a1", [edit("c1", "app.txt", "alpha\n", "ALPHA\n")]), result("r1", "c1"), assistant("a2", [edit("c2", "app.txt", "gamma\n", "GAMMA\n")]), result("r2", "c2")]));
    await writeFile(two, jsonl([header("pi-two", root), assistant("b1", [edit("d1", "app.txt", "ALPHA\nbeta\n", "ALPHA\nBeta\n")]), result("s1", "d1")]));
    const manifest = join(root, "selection.json");
    await writeFile(manifest, JSON.stringify({ schemaVersion: 1, head: git(root, "rev-parse", "HEAD").trim(),
      sources: [{ kind: "session-file", path: one, sessionId: "pi-one" }, { kind: "session-file", path: two, sessionId: "pi-two" }],
      mutations: [{ sessionId: "pi-one", resultEventId: "r1" }, { sessionId: "pi-two", resultEventId: "s1" }] }));
    assert.match(stage(["--agent", "pi", "--manifest", manifest, "--repository", root]).stderr, /caller session identity/);
    const run = stage(["--agent", "pi", "--manifest", manifest, "--repository", root], { PI_SESSION_ID: "pi-caller" });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.sessionId, "pi-caller");
    assert.deepEqual(report.selection.mutations.map((m: { sessionId: string; resultEventId: string }) => `${m.sessionId}:${m.resultEventId}`), ["pi-one:r1", "pi-two:s1"]);
    // The unselected r2 from the first session stays out of the index.
    assert.equal(git(root, "show", ":app.txt"), "ALPHA\nBeta\ngamma\n");
  }));

  it("discovers the transcript from Pi's environment and refuses mismatched identities or agents", async () => repo(async root => {
    const agentDir = join(root, ".pi-agent");
    const dir = join(agentDir, "sessions", "--repo--");
    await mkdir(dir, { recursive: true });
    const file = join(dir, "2026-11-01T10-00-00-000Z_pi-session-1.jsonl");
    await writeFile(file, session(root));
    const ids = (run: ReturnType<typeof stage>) => run.stdout.trim().split("\n").map(line => JSON.parse(line).resultEventId);
    const viaFile = stage(["--agent", "pi", "--list"], { PI_SESSION_FILE: file, PI_SESSION_ID: "pi-session-1" });
    assert.equal(viaFile.status, 0, viaFile.stderr);
    assert.deepEqual(ids(viaFile), ["r1", "r2", "r3"]);
    const viaId = stage(["--agent", "pi", "--list"], { PI_SESSION_ID: "pi-session-1", PI_CODING_AGENT_DIR: agentDir });
    assert.deepEqual(ids(viaId), ["r1", "r2", "r3"]);
    const viaSessionDir = stage(["--agent", "pi", "--list", "--session", "pi-session-1"], { PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions") });
    assert.deepEqual(ids(viaSessionDir), ["r1", "r2", "r3"]);
    assert.match(stage(["--agent", "pi", "--list"], { PI_SESSION_FILE: file, PI_SESSION_ID: "other" }).stderr, /does not match the requested session/);
    assert.match(stage(["--agent", "pi", "--list"], { PI_CODING_AGENT_DIR: agentDir }).stderr, /session identity is unavailable/);
    assert.match(stage(["--agent", "pi", "--list", "--session", "absent"], { PI_CODING_AGENT_DIR: agentDir }).stderr, /found 0/);
    assert.match(stage(["--agent", "claude", "--session-file", file, "--list"]).stderr, /pi session, not --agent claude/);
  }));
});
