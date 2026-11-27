import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { listMessages, loadConversation } from "../src/analysis/conversation.js";
import { loadSessionFile } from "../src/analysis/session.js";
import { resolveSessions } from "../src/pi/resolve-sessions.js";
import { toolFamily } from "../src/analysis/tool-family.js";

// Regression coverage for problems a fresh agent hit while using dvdst.
// Every fixture is synthetic.
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
const cli = (args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) =>
  spawnSync(process.execPath, [join(process.cwd(), "bin/dvdst.mjs"), ...args], { encoding: "utf8", cwd: options.cwd ?? process.cwd(), env: { ...process.env, DVDST_CACHE: "off", ...options.env } });
const msg = (id: string, role: string, content: unknown, extra = {}) => ({ type: "message", id, message: { role, content, ...extra } });
const text = (value: string) => [{ type: "text", text: value }];

// Seven canonical messages; two assistant messages hold only thinking or tool calls.
const piSession = [
  { type: "session", id: "usability-pi", cwd: "/work/project", timestamp: "2026-11-01T10:00:00.000Z" },
  msg("u1", "user", text("Check the build")),
  msg("a1", "assistant", [{ type: "thinking", thinking: "planning" }]),
  msg("a2", "assistant", [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm run build" } }]),
  msg("r1", "toolResult", text("ok"), { toolCallId: "c1", isError: false }),
  msg("a3", "assistant", [{ type: "text", text: "   " }]),
  msg("a4", "assistant", text("The build passes.")),
];

async function temporary(run: (root: string, file: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "dvdst-usability-"));
  try { const file = join(root, "session.jsonl"); await writeFile(file, jsonl(piSession)); await run(root, file); }
  finally { await rm(root, { recursive: true, force: true }); }
}

describe("messages --nonempty", () => {
  it("skips text-less messages while seq keeps addressing the full conversation", async () => temporary(async (_root, file) => {
    const conversation = await loadConversation(file);
    const all = listMessages(conversation);
    assert.equal(all.matched, 5);
    assert.deepEqual(all.rows.filter(row => row.text.totalChars === 0).map(row => row.seq), [2, 3]);
    const page = listMessages(conversation, { nonempty: true });
    assert.equal(page.matched, 2);
    assert.deepEqual(page.rows.map(row => [row.seq, row.role]), [[1, "user"], [6, "assistant"]]);
    const run = cli(["messages", file, "--nonempty", "--fields", "seq", "--format", "tsv"]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "seq\n1\n6\n");
    // seq from a filtered row still opens the same message.
    const opened = JSON.parse(cli(["message", file, "--seq", "6", "--before", "0", "--after", "0"]).stdout);
    assert.equal(opened.messages[0].text.text, "The build passes.");
    assert.match(cli(["search", file, "--query", "x", "--nonempty"]).stderr, /--nonempty does not apply to search/);
  }));
});

describe("documented JSON shapes", () => {
  it("keeps --format json a bare array and --page an envelope that reports offset", async () => temporary(async (_root, file) => {
    const bare = JSON.parse(cli(["messages", file, "--format", "json"]).stdout);
    assert.ok(Array.isArray(bare));
    const page = JSON.parse(cli(["messages", file, "--page", "--offset", "1", "--limit", "1"]).stdout);
    assert.ok(!Array.isArray(page));
    assert.deepEqual([page.matched, page.offset, page.returned, page.nextOffset], [5, 1, 1, 2]);
    for (const name of ["messages", "search"]) {
      const detail = JSON.parse(cli(["capabilities", name]).stdout);
      const entry = detail.command ?? detail;
      assert.match(JSON.stringify(entry), /bare JSON array of rows/);
      assert.match(JSON.stringify(entry), /rows are under rows/);
    }
    assert.match(cli(["messages", "--help"]).stderr, /--format json is a bare JSON array of rows; --page is one JSON envelope/);
  }));
});

describe("offset past the end", () => {
  it("returns pure data on stdout and says so on stderr, while --page reports it in the envelope", async () => temporary(async (_root, file) => {
    const tsv = cli(["messages", file, "--offset", "50", "--format", "tsv", "--fields", "seq"]);
    assert.equal(tsv.status, 0);
    assert.equal(tsv.stdout, "seq\n");
    assert.match(tsv.stderr, /--offset 50 is at or past the 5 matching row\(s\); no rows returned/);
    const jsonlRun = cli(["search", file, "--query", "build", "--offset", "9"]);
    assert.equal(jsonlRun.stdout, "");
    assert.match(jsonlRun.stderr, /--offset 9 is at or past the 2 matching row\(s\)/);
    const page = cli(["messages", file, "--offset", "50", "--page"]);
    assert.equal(page.stderr, "");
    assert.deepEqual((({ matched, offset, returned, nextOffset, rows }) => ({ matched, offset, returned, nextOffset, rows }))(JSON.parse(page.stdout)), { matched: 5, offset: 50, returned: 0, nextOffset: null, rows: [] });
    const calls = cli(["calls", file, "--offset", "5"]);
    assert.equal(calls.stdout, "");
    assert.match(calls.stderr, /--offset 5 is at or past the 1 matching row\(s\)/);
    assert.equal(cli(["messages", file, "--offset", "4"]).stderr, "");
  }));
});

describe("discovery fallback notice", () => {
  it("names a fallback from the working directory to every project on stderr only", async () => {
    const home = await mkdtemp(join(tmpdir(), "dvdst-fallback-"));
    try {
      const other = join(home, ".pi", "agent", "sessions", "--work-other--");
      await mkdir(other, { recursive: true });
      await writeFile(join(other, "2026-11-01T10-00-00-000Z_usability-pi.jsonl"), jsonl(piSession));
      const notices: string[] = [];
      const options = { home, env: {}, onNotice: (message: string) => notices.push(message) };
      assert.equal((await resolveSessions({ ...options, cwd: "/work/empty", specs: [], source: "all", last: 1 })).length, 1);
      assert.equal(notices.length, 1);
      assert.match(notices[0]!, /no pi, claude, or codex sessions recorded for the working directory \/work\/empty; selecting from every project/);
      await resolveSessions({ ...options, cwd: "/work/empty", specs: ["latest"] });
      assert.match(notices[1]!, /no pi sessions recorded/);
      await resolveSessions({ ...options, cwd: "/work/other", specs: [], last: 1 });
      await resolveSessions({ ...options, cwd: "/work/empty", specs: [], project: "other", last: 1 });
      await resolveSessions({ ...options, cwd: "/work/empty", specs: ["usability-pi"] });
      assert.equal(notices.length, 2, "cwd matches, explicit projects, and id lookups do not fall back");
      const empty = await mkdtemp(join(tmpdir(), "dvdst-empty-cwd-"));
      try {
        const run = cli(["overview", "--source", "all", "--last", "1", "--fields", "session"], { cwd: empty, env: { HOME: home, CODEX_HOME: join(home, ".codex") } });
        assert.equal(run.status, 0, run.stderr);
        assert.deepEqual(JSON.parse(run.stdout), { session: "usability-pi" });
        assert.match(run.stderr, /^dvdst: no pi, claude, or codex sessions recorded for the working directory .*selecting from every project instead/m);
      } finally { await rm(empty, { recursive: true, force: true }); }
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});

describe("cross-agent tool family", () => {
  it("maps each agent's names to one family and keeps the raw tool name", async () => {
    assert.deepEqual(["bash", "exec", "write_stdin", "wait", "sleep", "Monitor", "read", "view_image", "edit", "apply_patch", "write", "grep", "Glob", "WebFetch", "web", "mcp__x__y"].map(toolFamily),
      ["shell", "shell", "poll", "poll", "poll", "poll", "read", "read", "edit", "edit", "write", "search", "search", "web", "web", "other"]);
    const root = await mkdtemp(join(tmpdir(), "dvdst-family-"));
    try {
      const file = join(root, "rollout.jsonl");
      const rows: Array<[string, unknown]> = [
        ["session_meta", { id: "family-codex", cwd: "/work/app" }],
        ["turn_context", { model: "codex-test" }],
        ["response_item", { type: "function_call", name: "exec_command", call_id: "a", arguments: JSON.stringify({ cmd: "npm test" }) }],
        ["response_item", { type: "function_call_output", call_id: "a", output: "Process running with session ID 7" }],
        ["response_item", { type: "function_call", name: "write_stdin", call_id: "b", arguments: JSON.stringify({ session_id: 7, chars: "" }) }],
        ["response_item", { type: "function_call_output", call_id: "b", output: "Process exited with code 0" }],
        ["response_item", { type: "function_call", name: "wait", call_id: "c", arguments: "{}" }],
        ["response_item", { type: "function_call_output", call_id: "c", output: "done" }],
      ];
      await writeFile(file, rows.map(([type, payload], i) => JSON.stringify({ type, payload, timestamp: `2026-01-01T00:00:0${i}.000Z` })).join("\n") + "\n");
      const session = await loadSessionFile(file);
      assert.deepEqual(session.calls.map(call => [call.tool, call.family]), [["bash", "shell"], ["write_stdin", "poll"], ["wait", "poll"]]);
      assert.deepEqual(session.overview.families, { poll: 2, shell: 1 });
      const filtered = cli(["calls", file, "--family", "poll", "--fields", "tool", "--format", "tsv"]);
      assert.equal(filtered.stdout, "tool\nwrite_stdin\nwait\n");
      assert.match(cli(["calls", file, "--family", "nope"]).stderr, /--family must be one of shell, poll/);
      assert.match(cli(["turns", file, "--family", "poll"]).stderr, /filter the calls stream only/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("recorded cost and channel", () => {
  const claudeEntries = (cost: Record<string, unknown> | undefined) => [
    { type: "user", sessionId: "cost-claude", uuid: "u1", cwd: "/work/app", timestamp: "2026-11-01T10:00:00.000Z", message: { role: "user", content: "hi" } },
    { type: "assistant", sessionId: "cost-claude", uuid: "a1", timestamp: "2026-11-01T10:00:01.000Z", message: { id: "m1", role: "assistant", model: "claude-test", content: [{ type: "text", text: "hello" }], usage: { input_tokens: 3, output_tokens: 2 } } },
    ...(cost === undefined ? [] : [
      { type: "cost-state", sessionId: "cost-claude", totalCostUSD: 0.01, hasUnknownModelCost: false, modelUsage: {} },
      { type: "cost-state", sessionId: "cost-claude", modelUsage: {}, ...cost },
    ]),
  ];

  it("uses Claude Code's recorded session total and never prices requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-cost-"));
    try {
      const file = join(root, "cost-claude.jsonl");
      await writeFile(file, jsonl(claudeEntries({ totalCostUSD: 0.25, hasUnknownModelCost: false })));
      let session = await loadSessionFile(file);
      assert.deepEqual([session.overview.cost, session.overview.costBasis, session.turns[0]!.cost], [0.25, "session", null]);
      await writeFile(file, jsonl(claudeEntries({ totalCostUSD: 0.5, hasUnknownModelCost: true })));
      session = await loadSessionFile(file);
      assert.deepEqual([session.overview.cost, session.overview.costBasis], [null, null]);
      await writeFile(file, jsonl(claudeEntries(undefined)));
      session = await loadSessionFile(file);
      assert.deepEqual([session.overview.cost, session.overview.costBasis], [null, null]);
      // Pi's per-request costs keep their basis.
      const pi = join(root, "pi.jsonl");
      await writeFile(pi, jsonl([piSession[0], msg("a", "assistant", text("x"), { usage: { input: 1, output: 1, cost: { total: 0.002 } } })]));
      session = await loadSessionFile(pi);
      assert.deepEqual([session.overview.cost, session.overview.costBasis], [0.002, "requests"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("captures the Codex phase as the message channel when no channel is recorded", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-phase-"));
    try {
      const file = join(root, "rollout.jsonl");
      const rows: Array<[string, unknown]> = [
        ["session_meta", { id: "phase-codex", cwd: "/work/app" }],
        ["response_item", { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Looking" }] }],
        ["response_item", { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Done" }] }],
        ["response_item", { type: "message", role: "assistant", channel: "analysis", phase: "commentary", content: [{ type: "output_text", text: "Both" }] }],
        ["response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Neither" }] }],
      ];
      await writeFile(file, rows.map(([type, payload]) => JSON.stringify({ type, payload })).join("\n") + "\n");
      const page = listMessages(await loadConversation(file));
      assert.deepEqual(page.rows.map(row => row.channel), ["commentary", "final_answer", "analysis", null]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("message reader self-description", () => {
  it("names the output keys in help and capabilities without changing the JSON", async () => temporary(async (_root, file) => {
    assert.match(cli(["message", "--help"]).stderr, /\{schemaVersion, source, session, path, fingerprint, anchorSeq, messages, beforeRef, afterRef\}.*\n.*Run dvdst schema message/);
    const detail = JSON.parse(cli(["capabilities", "message"]).stdout);
    assert.match(JSON.stringify(detail), /anchorSeq, messages, beforeRef, afterRef/);
    const result = JSON.parse(cli(["message", file, "--seq", "1"]).stdout);
    assert.deepEqual(Object.keys(result), ["schemaVersion", "source", "session", "path", "fingerprint", "anchorSeq", "messages", "beforeRef", "afterRef"]);
  }));
});
