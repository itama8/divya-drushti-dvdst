import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, copyFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { STREAMS } from "../src/analysis/rows.js";
import { loadSessionFile } from "../src/analysis/session.js";
import { resolveSession, resolveSessions } from "../src/pi/resolve-sessions.js";
import { readSessionRecords } from "../src/sources/read-session.js";

const FIXTURE = "test/fixtures/claude-session.jsonl";
const PI_FIXTURE = "test/fixtures/skill-session.jsonl";

describe("Claude Code sessions", () => {
  it("detects the source of a session file", async () => {
    assert.equal((await readSessionRecords(FIXTURE)).source, "claude");
    assert.equal((await readSessionRecords(PI_FIXTURE)).source, "pi");
  });

  it("merges the blocks of one request into one turn with its final usage", async () => {
    const session = await loadSessionFile(FIXTURE);
    assert.equal(session.source, "claude");
    assert.equal(session.session, "claude-fixture");
    assert.equal(session.cwd, "/work/app");
    assert.equal(session.turns.length, 2, "the sidechain request is left out");
    const first = session.turns[0]!;
    assert.deepEqual(
      { line: first.line, model: first.model, provider: first.provider, stopReason: first.stopReason, thinkingLevel: first.thinkingLevel },
      { line: 4, model: "claude-test", provider: "anthropic", stopReason: "tool_use", thinkingLevel: "high" },
    );
    assert.deepEqual(
      { input: first.inputTokens, output: first.outputTokens, cacheRead: first.cacheReadTokens, cacheWrite: first.cacheWriteTokens, reasoning: first.reasoningTokens, context: first.contextTokens },
      { input: 10, output: 40, cacheRead: 100, cacheWrite: 20, reasoning: 7, context: 130 },
    );
    assert.equal(first.endedAt, "2026-01-01T00:00:05.000Z");
    assert.equal(first.startedAt, null, "Claude Code does not record when a request started");
    assert.equal(first.cost, null);
    assert.deepEqual(first.tools, ["read", "bash"]);
  });

  it("names the core tools and their arguments as every other source does", async () => {
    const session = await loadSessionFile(FIXTURE);
    const [read, bash, edit] = session.calls as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
    assert.deepEqual({ tool: read.tool, path: read.path, reads: read.reads, truncated: read.truncated, isError: read.isError }, { tool: "read", path: "src/parser.ts", reads: ["src/parser.ts"], truncated: true, isError: false });
    assert.equal(read.durationMs, 500, "a call starts when its own block arrived");
    assert.deepEqual({ tool: bash.tool, command: bash.command, classes: bash.classes, isError: bash.isError, exitCode: bash.exitCode, durationMs: bash.durationMs }, { tool: "bash", command: "npm test", classes: ["test"], isError: true, exitCode: 2, durationMs: 4000 });
    assert.deepEqual({ tool: edit.tool, path: edit.path, mutates: edit.mutates, line: edit.line, resultLine: edit.resultLine }, { tool: "edit", path: "src/parser.ts", mutates: ["src/parser.ts"], line: 9, resultLine: 10 });
    assert.deepEqual((edit.args as { edits: unknown }).edits, [{ oldText: "a", newText: "b" }]);
    assert.equal((edit.args as { old_string: string }).old_string, "a", "the original arguments stay");
  });

  it("counts prompts, not client echoes, and reports what the source lacks", async () => {
    const { overview } = await loadSessionFile(FIXTURE);
    assert.equal(overview.source, "claude");
    assert.equal(overview.userTurns, 2);
    assert.equal(overview.firstPrompt, "Fix the parser");
    assert.equal(overview.lines, 14, "lines counts the file's own entries");
    assert.equal(overview.cost, null);
    assert.equal(overview.compactions, 1);
    assert.equal(overview.callsBeforeFirstMutation, 2);
    assert.deepEqual(Object.keys(overview), STREAMS.overview.fields.map((field) => field.name));
  });

  it("feeds the handoff the same way a Pi session does", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli/dvdst.ts", "handoff", FIXTURE], { encoding: "utf8" });
    assert.match(output, /^Session: claude-fixture/);
    assert.match(output, /Modified files \(1\):\n- src\/parser\.ts/);
    assert.match(output, /Commands: total=1 failed=1 tests=1/);
  });
});

describe("session resolution across sources", () => {
  async function homes(): Promise<{ home: string; claude: string; pi: string }> {
    const home = await mkdtemp(join(tmpdir(), "dvdst-sources-"));
    const claude = join(home, ".claude", "projects", "-work-my-app");
    const pi = join(home, ".pi", "agent", "sessions", "--work-my.app--");
    await mkdir(claude, { recursive: true });
    await mkdir(pi, { recursive: true });
    await copyFile(FIXTURE, join(claude, "11111111-aaaa.jsonl"));
    await writeFile(join(claude, "22222222-bbbb.jsonl"), `${JSON.stringify({ type: "user", sessionId: "22222222-bbbb", timestamp: "2026-01-03T00:00:00.000Z", message: { role: "user", content: "later" } })}\n`);
    await writeFile(join(pi, "2026-01-02T00-00-00-000Z_33333333-cccc.jsonl"), "{}\n");
    return { home, claude, pi };
  }

  it("selects one source unless asked for all, on one clock", async () => {
    const { home, claude, pi } = await homes();
    const options = { home, cwd: "/work/my.app", env: {} };
    assert.deepEqual(await resolveSessions({ ...options, specs: [], last: 5 }), [join(pi, "2026-01-02T00-00-00-000Z_33333333-cccc.jsonl")]);
    assert.deepEqual(await resolveSessions({ ...options, specs: [], source: "claude" }), [join(claude, "11111111-aaaa.jsonl"), join(claude, "22222222-bbbb.jsonl")]);
    assert.deepEqual(
      (await resolveSessions({ ...options, specs: [], source: "all", since: "2026-01-02" })).map((path) => path.split("/").pop()),
      ["2026-01-02T00-00-00-000Z_33333333-cccc.jsonl", "22222222-bbbb.jsonl"],
    );
    assert.equal(await resolveSession("latest", { ...options, source: "claude" }), join(claude, "22222222-bbbb.jsonl"));
    assert.equal(await resolveSession("latest", options), join(pi, "2026-01-02T00-00-00-000Z_33333333-cccc.jsonl"));
    assert.equal((await resolveSessions({ home, env: { DVDST_SOURCE: "claude" }, specs: [], project: "my.app" })).length, 2);
  });

  it("finds a session id whichever agent wrote it", async () => {
    const { home, claude } = await homes();
    assert.equal(await resolveSession("1111", { home, cwd: "/work/my.app", env: {} }), join(claude, "11111111-aaaa.jsonl"));
    assert.equal(await resolveSession("2222", { home, cwd: "/elsewhere", env: {} }), join(claude, "22222222-bbbb.jsonl"));
    await assert.rejects(resolveSessions({ home, env: {}, specs: [], source: "unknown" as never }), /--source must be pi, claude, codex, or all/);
  });
});
