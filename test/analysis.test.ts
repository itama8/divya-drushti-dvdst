import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deriveRows, STREAMS, type Row, type StreamName } from "../src/analysis/rows.js";
import { readJsonl, type SourceRecord } from "../src/pi/read-jsonl.js";
import { resolveSession, resolveSessions, SessionResolveError } from "../src/pi/resolve-sessions.js";

const FIXTURE = "test/fixtures/skill-session.jsonl";
const DISPATCHER = ["--import", "tsx", "src/cli/dvdst.ts"];

function records(entries: unknown[]): SourceRecord[] {
  return entries.map((value, index) => ({ value, source: { line: index + 1, byteStart: 0, byteEnd: 0 } }));
}

const SESSION = records([
  { type: "session", id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/work/app" },
  { type: "message", id: "sys", timestamp: "2026-01-01T00:00:00.500Z", message: { role: "system", sections: { rules: "be brief", skills: "éé" } } },
  { type: "message", id: "u1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Fix  the\nbug" }] } },
  {
    type: "message",
    id: "a1",
    timestamp: "2026-01-01T00:00:04.000Z",
    message: {
      role: "assistant",
      timestamp: Date.parse("2026-01-01T00:00:01.000Z"),
      model: "m1",
      provider: "p1",
      stopReason: "toolUse",
      usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 5, reasoning: 7, cost: { total: 0.5 } },
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "Looking." },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "/work/app/src/a.ts" } },
        { type: "toolCall", id: "c2", name: "bash", arguments: { command: "npm test" } },
      ],
    },
  },
  { type: "message", id: "r1", timestamp: "2026-01-01T00:00:04.100Z", message: { role: "toolResult", toolCallId: "c1", toolName: "read", isError: false, timestamp: Date.parse("2026-01-01T00:00:04.100Z"), content: [{ type: "text", text: "one\ntwo\n\n[Showing lines 1-2 of 900 (50.0KB limit). Use offset=3 to continue.]" }] } },
  { type: "message", id: "r2", timestamp: "2026-01-01T00:00:09.000Z", message: { role: "toolResult", toolCallId: "c2", toolName: "bash", isError: true, timestamp: Date.parse("2026-01-01T00:00:09.000Z"), content: [{ type: "text", text: "1 failing\n\nCommand exited with code 3" }] } },
  {
    type: "message",
    id: "a2",
    timestamp: "2026-01-01T00:00:12.000Z",
    message: {
      role: "assistant",
      timestamp: Date.parse("2026-01-01T00:00:09.500Z"),
      model: "m2",
      usage: { input: 50, output: 10, cacheRead: 600, cacheWrite: 0, cost: { total: 0.25 } },
      content: [
        { type: "toolCall", id: "c3", name: "edit", arguments: { path: "/elsewhere/b.ts", edits: [] } },
        { type: "toolCall", id: "c4", name: "bash", arguments: { command: "sleep 1" } },
      ],
    },
  },
  { type: "message", id: "r3", timestamp: "2026-01-01T00:00:12.200Z", message: { role: "toolResult", toolCallId: "c3", toolName: "edit", isError: false, content: [{ type: "text", text: "ok" }] } },
  { type: "compaction", id: "k1", timestamp: "2026-01-01T00:00:13.000Z" },
]);

describe("analysis rows", () => {
  const rows = deriveRows(SESSION, "/sessions/s1.jsonl");

  it("joins each tool call to its result", () => {
    assert.equal(rows.calls.length, 4);
    const [read, test, edit, orphan] = rows.calls as [Row, Row, Row, Row];
    assert.deepEqual(
      { seq: read.seq, turn: read.turn, userTurn: read.userTurn, line: read.line, resultLine: read.resultLine, tool: read.tool, path: read.path },
      { seq: 1, turn: 1, userTurn: 1, line: 4, resultLine: 5, tool: "read", path: "src/a.ts" },
    );
    assert.equal(read.truncated, true);
    assert.equal(read.durationMs, 100);
    assert.equal(read.isError, false);
    assert.equal(read.resultLines, 4);

    assert.equal(test.command, "npm test");
    assert.deepEqual(test.classes, ["test"]);
    assert.equal(test.isError, true);
    assert.equal(test.exitCode, 3);
    assert.equal(test.durationMs, 5000);
    assert.equal(test.truncated, false);

    assert.equal(edit.path, "/elsewhere/b.ts", "a path outside the session cwd stays absolute");
    assert.equal(edit.endedAt, "2026-01-01T00:00:12.200Z", "falls back to the entry timestamp");

    assert.deepEqual(
      { resultLine: orphan.resultLine, isError: orphan.isError, durationMs: orphan.durationMs, resultBytes: orphan.resultBytes },
      { resultLine: null, isError: null, durationMs: null, resultBytes: null },
      "a call without a result reports unknowns, not a success",
    );
  });

  it("reports tokens, cost, and timing per model request", () => {
    assert.equal(rows.turns.length, 2);
    const first = rows.turns[0]!;
    assert.equal(first.generationMs, 3000);
    assert.equal(first.contextTokens, 405);
    assert.equal(first.reasoningTokens, 7);
    assert.equal(first.cost, 0.5);
    assert.equal(first.textBytes, 8);
    assert.equal(first.thinkingBytes, 3);
    assert.deepEqual(first.tools, ["read", "bash"]);
    assert.equal(rows.turns[1]!.reasoningTokens, 0);
  });

  it("sizes each system prompt section in bytes", () => {
    assert.deepEqual(rows.context, [
      { session: "s1", line: 2, section: "rules", bytes: 8 },
      { session: "s1", line: 2, section: "skills", bytes: 4 },
    ]);
  });

  it("summarizes the session", () => {
    const overview = rows.overview;
    assert.equal(overview.session, "s1");
    assert.equal(overview.cwd, "/work/app");
    assert.equal(overview.wallMs, 13000);
    assert.equal(overview.firstPrompt, "Fix the bug");
    assert.deepEqual(overview.models, ["m1", "m2"]);
    assert.deepEqual(overview.tools, { bash: 2, edit: 1, read: 1 });
    assert.equal(overview.errorCalls, 1);
    assert.equal(overview.truncatedCalls, 1);
    assert.equal(overview.callsBeforeFirstMutation, 2);
    assert.equal(overview.inputTokens, 150);
    assert.equal(overview.cacheReadTokens, 900);
    assert.equal(overview.peakContextTokens, 650);
    assert.equal(overview.cost, 0.75);
    assert.equal(overview.systemPromptBytes, 12);
    assert.equal(overview.compactions, 1);
  });

  it("adds payloads only when asked", () => {
    const full = deriveRows(SESSION, "/sessions/s1.jsonl", { full: true });
    assert.deepEqual(full.calls[1]!.args, { command: "npm test" });
    assert.match(full.calls[1]!.resultText as string, /1 failing/);
    assert.equal(full.context[0]!.text, "be brief");
    assert.equal("args" in rows.calls[1]!, false);
  });

  it("emits only fields the schema declares", async () => {
    const fixture = deriveRows(await readJsonl(FIXTURE), FIXTURE, { full: true });
    const full = deriveRows(SESSION, "/sessions/s1.jsonl", { full: true });
    for (const derived of [fixture, full]) {
      const streams: Record<StreamName, Row[]> = { overview: [derived.overview], turns: derived.turns, calls: derived.calls, context: derived.context };
      for (const [name, streamRows] of Object.entries(streams) as Array<[StreamName, Row[]]>) {
        const declared = STREAMS[name].fields.map((field) => field.name);
        for (const row of streamRows) {
          for (const key of Object.keys(row)) assert.ok(declared.includes(key), `${name}.${key} is not in the schema`);
        }
      }
    }
    const declaredOverview = STREAMS.overview.fields.map((field) => field.name);
    assert.deepEqual(Object.keys(full.overview), declaredOverview, "every overview field is always present, in schema order");
  });
});

describe("session resolution", () => {
  async function corpus(): Promise<{ home: string; project: string; names: string[] }> {
    const home = await mkdtemp(join(tmpdir(), "dvdst-resolve-"));
    const project = join(home, ".pi", "agent", "sessions", "--work-app--");
    const other = join(home, ".pi", "agent", "sessions", "--work-other--");
    await mkdir(project, { recursive: true });
    await mkdir(other, { recursive: true });
    const names = [
      "2026-01-01T00-00-00-000Z_aaaa1111-0000.jsonl",
      "2026-01-02T00-00-00-000Z_aaaa2222-0000.jsonl",
      "2026-01-03T00-00-00-000Z_bbbb3333-0000.jsonl",
    ];
    for (const name of names) await writeFile(join(project, name), "{}\n");
    await writeFile(join(other, "2026-01-04T00-00-00-000Z_cccc4444-0000.jsonl"), "{}\n");
    return { home, project, names };
  }

  it("resolves a file, an id prefix, a timestamp prefix, and latest", async () => {
    const { home, project, names } = await corpus();
    const options = { home, cwd: "/work/app", env: {} };
    assert.equal(await resolveSession(FIXTURE, options), FIXTURE);
    assert.equal(await resolveSession("bbbb", options), join(project, names[2]!));
    assert.equal(await resolveSession("2026-01-02", options), join(project, names[1]!));
    assert.equal(await resolveSession("latest", options), join(project, names[2]!));
  });

  it("widens an id lookup to other projects when the working directory has no match", async () => {
    const { home } = await corpus();
    const path = await resolveSession("cccc4444", { home, cwd: "/work/app", env: {} });
    assert.match(path, /--work-other--/);
  });

  it("selects several sessions oldest first", async () => {
    const { home, project, names } = await corpus();
    const options = { home, cwd: "/work/app", env: {} };
    assert.deepEqual(await resolveSessions({ ...options, specs: [], last: 2 }), [join(project, names[1]!), join(project, names[2]!)]);
    assert.deepEqual(await resolveSessions({ ...options, specs: [], since: "2026-01-02" }), [join(project, names[1]!), join(project, names[2]!)]);
    assert.equal((await resolveSessions({ home, env: {}, specs: [], project: "other", last: 5 })).length, 1);
    assert.equal((await resolveSessions({ ...options, specs: [project] })).length, 3);
  });

  it("uses PI_SESSION_FILE when no session is named", async () => {
    assert.equal(await resolveSession(undefined, { env: { PI_SESSION_FILE: "/x/current.jsonl" } }), "/x/current.jsonl");
  });

  it("explains an ambiguous, missing, or absent spec", async () => {
    const { home } = await corpus();
    const options = { home, cwd: "/work/app", env: {} };
    await assert.rejects(resolveSession("aaaa", options), (error: Error) => error instanceof SessionResolveError && /matches 2 sessions/.test(error.message));
    await assert.rejects(resolveSession("zzzz", options), /No session matches "zzzz"/);
    await assert.rejects(resolveSession(undefined, options), /No session given/);
  });
});

describe("analysis CLI", () => {
  it("writes one JSON row per line", () => {
    const output = execFileSync(process.execPath, [...DISPATCHER, "calls", FIXTURE], { encoding: "utf8" });
    const rows = output.trimEnd().split("\n").map((line) => JSON.parse(line) as Row);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => row.session === "fixture-session"));
    const filtered = execFileSync(process.execPath, [...DISPATCHER, "calls", FIXTURE, "--tool", "bash", "--format", "tsv"], { encoding: "utf8" });
    const lines = filtered.trimEnd().split("\n");
    assert.equal(lines[0]!.split("\t")[0], "session");
    assert.equal(lines.length - 1, rows.filter((row) => row.tool === "bash").length);
  });

  it("prints the row schema", () => {
    const schema = JSON.parse(execFileSync(process.execPath, [...DISPATCHER, "schema", "calls", "--format", "json"], { encoding: "utf8" })) as Record<string, { fields: unknown[] }>;
    assert.deepEqual(Object.keys(schema), ["calls"]);
    assert.equal(schema.calls!.fields.length, STREAMS.calls.fields.length);
  });

  it("lists every command with a description", () => {
    const help = spawnSync(process.execPath, [...DISPATCHER, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    for (const command of ["overview", "calls", "handoff", "stage"]) assert.match(help.stderr, new RegExp(`^  ${command}\\s+\\S`, "m"));
    const unknown = spawnSync(process.execPath, [...DISPATCHER, "nope"], { encoding: "utf8" });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown command or extractor "nope"/);
    const invalid = spawnSync(process.execPath, [...DISPATCHER, "../x"], { encoding: "utf8" });
    assert.equal(invalid.status, 2);
  });

  it("accepts the session as a positional or as --session", () => {
    const positional = execFileSync(process.execPath, [...DISPATCHER, "handoff", FIXTURE], { encoding: "utf8" });
    const flagged = execFileSync(process.execPath, [...DISPATCHER, "handoff", "--session", FIXTURE], { encoding: "utf8" });
    assert.equal(positional, flagged);
    assert.match(positional, /^Session: fixture-session/);
  });
});

describe("extractors and the library", () => {
  it("runs an extractor file per session with declared TSV columns", () => {
    const output = execFileSync(process.execPath, [...DISPATCHER, "rows", "examples/extractors/orientation.mjs", FIXTURE, "--format", "tsv"], { encoding: "utf8" });
    const [columns, row] = output.trimEnd().split("\n").map((line) => line.split("\t")) as [string[], string[]];
    assert.deepEqual(columns.slice(0, 3), ["session", "model", "callsBeforeFirstMutation"]);
    assert.equal(row[0], "fixture-session");
  });

  it("applies summarize across the selected sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-extractor-"));
    const session = (id: string, command: string): string =>
      [
        { type: "session", id, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/work/app" },
        { type: "message", id: "a", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command } }] } },
        { type: "message", id: "r", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "toolResult", toolCallId: "c", isError: true, content: [{ type: "text", text: "no\n\nCommand exited with code 2" }] } },
      ].map((entry) => JSON.stringify(entry)).join("\n");
    await writeFile(join(root, "one.jsonl"), session("one", "cd /work/app && npm run build 2>&1 | tail -5"));
    await writeFile(join(root, "two.jsonl"), session("two", "npm run build"));
    const output = execFileSync(process.execPath, [...DISPATCHER, "rows", "examples/extractors/failing-commands.mjs", join(root, "one.jsonl"), join(root, "two.jsonl")], { encoding: "utf8" });
    assert.deepEqual(output.trimEnd().split("\n").map((line) => JSON.parse(line) as Row), [
      { command: "npm run build", failures: 2, sessions: 2, exitCodes: [2], wastedMs: 4000 },
    ]);
  });

  it("finds a project extractor by name and lists it in the schema", async () => {
    const project = await mkdtemp(join(tmpdir(), "dvdst-project-"));
    await mkdir(join(project, ".dvdst", "extractors"), { recursive: true });
    await writeFile(
      join(project, ".dvdst", "extractors", "tools.mjs"),
      'export default { description: "tool per call", derive: (session) => session.calls.map((call) => ({ tool: call.tool, hasArgs: call.args !== undefined })) };\n',
    );
    const cli = [process.execPath, "--import", import.meta.resolve("tsx"), join(process.cwd(), "src/cli/dvdst.ts")] as const;
    const fixture = join(process.cwd(), FIXTURE);
    const run = (args: string[]): string => execFileSync(cli[0], [...cli.slice(1), ...args], { encoding: "utf8", cwd: project });
    const rows = run(["tools", fixture]).trimEnd().split("\n").map((line) => JSON.parse(line) as Row);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => typeof row.tool === "string" && row.hasArgs === true), "an extractor sees full call rows");
    assert.match(run(["schema"]), /^tools: tool per call$/m);
    assert.match(run(["schema", "tools", "--format", "json"]), /"summarizes": false/);
  });

  it("rejects a file that is not an extractor", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-bad-extractor-"));
    await writeFile(join(root, "bad.mjs"), "export default { description: 'no derive' };\n");
    const result = spawnSync(process.execPath, [...DISPATCHER, "rows", join(root, "bad.mjs"), FIXTURE], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must default-export an object with a derive\(session\) function/);
  });

  it("loads sessions through the library entry point", async () => {
    const { loadSession, loadSessions } = await import("../src/index.js");
    const session = await loadSession(FIXTURE);
    assert.equal(session.session, "fixture-session");
    assert.equal(session.calls.length, session.overview.calls);
    assert.ok(session.calls.every((call) => "args" in call), "the library returns full rows by default");
    const ids: string[] = [];
    for await (const loaded of loadSessions({ specs: [FIXTURE], full: false })) ids.push(loaded.session);
    assert.deepEqual(ids, ["fixture-session"]);
  });
});
