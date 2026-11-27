import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConversation, listMessages, searchConversation, readMessage } from "../src/analysis/conversation.js";
import { readCall } from "../src/analysis/read-call.js";
import { MESSAGES_SCHEMA, SEARCH_SCHEMA } from "../src/analysis/conversation-schema.js";

const cli = (...args: string[]) => spawnSync(process.execPath, ["bin/dvdst.mjs", ...args], { encoding: "utf8", env: { ...process.env, DVDST_CACHE: "off" } });
const msg = (id: string, role: string, content: unknown, extra = {}) => ({ type: "message", id, message: { role, content, ...extra } });
const text = (value: string) => [{ type: "text", text: value }];
const correction = "😀 Correction: keep local Open.\nDo not upload drawings.";
const piRecords = [
  { type: "session", id: "same-session", cwd: "/work/project" },
  msg("system", "system", [], { sections: { rules: "System policy words" } }),
  msg("u1", "user", text("Investigate the viewer")),
  msg("a1", "assistant", [{ type: "thinking", thinking: "SECRET THINKING" }, ...text("Checking the parser"), { type: "toolCall", id: "test", name: "bash", arguments: { command: "npm test -- --parser" } }]),
  msg("r1", "toolResult", text("parser validation failed"), { toolCallId: "test", isError: true }),
  msg("u2", "user", text(correction)),
  msg("a2", "assistant", [...text("Decision: keep local Open."), { type: "image", data: "SECRET IMAGE" }]),
  msg("orphan", "toolResult", text("orphan result needle"), { toolCallId: "unknown", isError: false }),
  msg("a3", "assistant", [{ type: "toolCall", id: "opaque", name: "custom_tool", arguments: { query: "SECRET ARGUMENT" } }]),
];
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
async function temporary(run: (file: string, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "dvdst-conversation-"));
  const file = join(root, "session.jsonl");
  try { await writeFile(file, jsonl(piRecords)); await run(file, root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

describe("conversation exploration", () => {
  it("lists canonical messages with stable positions, bounded text, and call links", async () => temporary(async file => {
    const conversation = await loadConversation(file);
    const page = listMessages(conversation, { limit: 2, textLimit: 8 });
    assert.equal(page.matched, 5);
    assert.equal(page.nextOffset, 2);
    assert.deepEqual(page.rows.map(row => [row.seq, row.role]), [[2, "user"], [3, "assistant"]]);
    assert.equal(page.rows[0]!.text.text, "Investig");
    const all = listMessages(conversation, { roles: "all" });
    assert.equal(all.matched, 8);
    const assistant = all.rows.find(row => row.id === "a1")!;
    assert.equal(assistant.turn, conversation.session.calls[0]!.turn);
    assert.deepEqual(assistant.callIds, ["test"]);
    assert.equal((await readCall({ ref: assistant.callRefs[0]! })).call.callId, "test");
    const result = all.rows.find(row => row.id === "r1")!;
    assert.equal(result.resultCallRef, assistant.callRefs[0]);
    for (const row of all.rows) assert.deepEqual(Object.keys(row).sort(), MESSAGES_SCHEMA.fields.map(field => field.name).sort());
  }));

  it("returns complete text with --full, beyond the 4096 prefix bound and the 65536 reader limit", async () => temporary(async file => {
    const long = `Plan:\n${"😀 finding ".repeat(8000)}\nEnd of review.`;
    await writeFile(file, jsonl([...piRecords, msg("u3", "user", text("review it")), msg("a4", "assistant", text(long))]));
    const conversation = await loadConversation(file);
    const bounded = listMessages(conversation, { offset: 3, textLimit: 4096 }).rows.find(row => row.id === "a4")!;
    assert.equal(bounded.text.truncated, true);
    assert.equal(bounded.text.totalChars, Array.from(long).length);
    const whole = listMessages(conversation, { offset: 3, full: true }).rows.find(row => row.id === "a4")!;
    assert.equal(whole.text.text, long);
    assert.deepEqual([whole.text.offset, whole.text.totalChars, whole.text.nextOffset, whole.text.truncated], [0, Array.from(long).length, null, false]);
    assert.ok(whole.text.totalChars > 65536);
    const hit = searchConversation(conversation, { query: "End of review", full: true }).rows[0]!;
    assert.equal(hit.excerpt.text, long);
    assert.equal(hit.match.offset, Array.from(long).length - "End of review.".length);
    const cliRows = cli("messages", file, "--full", "--offset", "3", "--fields", "id,text").stdout.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(cliRows.find(row => row.id === "a4").text.text, long);
    const rejected = cli("messages", file, "--full", "--text-limit", "10");
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /--full or --text-limit/);
  }));

  it("finds a late correction and expands its actual neighbors", async () => temporary(async file => {
    const hits = searchConversation(await loadConversation(file), { query: "Correction", roles: ["user"], textLimit: 20 });
    assert.equal(hits.matched, 1);
    const hit = hits.rows[0]!;
    assert.equal(hit.line, 6);
    assert.equal(hit.match.offset, 2, "offset counts emoji as one Unicode code point");
    assert.equal(hit.messageSeq, 5);
    assert.equal(hit.refKind, "message");
    assert.deepEqual(Object.keys(hit).sort(), SEARCH_SCHEMA.fields.map(field => field.name).sort());
    const window = await readMessage({ ref: hit.messageRef, before: 1, after: 1, limit: 12 });
    assert.deepEqual(window.messages.map(row => row.id), ["r1", "u2", "a2"]);
    assert.equal(window.anchorSeq, 5);
    assert.equal(window.messages[1]!.text.nextOffset, 12);
    assert.equal((await readMessage({ ref: hit.ref, before: 0, after: 0, limit: 12, textOffset: 12 })).messages[0]!.text.text, Array.from(correction).slice(12, 24).join(""));
    assert.equal((await readMessage({ ref: window.beforeRef!, before: 0, after: 0 })).messages[0]!.id, "a1");
    assert.equal((await readMessage({ ref: window.afterRef!, before: 0, after: 0 })).messages[0]!.id, "orphan");
  }));

  it("searches commands/results and follows them to calls or orphan messages", async () => temporary(async file => {
    const conversation = await loadConversation(file);
    const command = searchConversation(conversation, { query: "npm test", scope: "commands" }).rows[0]!;
    assert.equal(command.kind, "command");
    assert.equal(command.refKind, "call");
    assert.equal((await readCall({ ref: command.ref })).command?.text, "npm test -- --parser");
    assert.equal((await readMessage({ ref: command.messageRef, before: 0, after: 0 })).messages[0]!.id, "a1");
    assert.equal((await readMessage({ ref: command.ref, before: 0, after: 0 })).messages[0]!.id, "a1", "call refs also lead directly to the requesting conversation message");
    const result = searchConversation(conversation, { query: "validation failed", scope: "results" }).rows[0]!;
    assert.equal(result.callId, "test");
    assert.equal((await readCall({ ref: result.ref })).result?.text, "parser validation failed");
    const orphan = searchConversation(conversation, { query: "orphan result", scope: "results" }).rows[0]!;
    assert.equal(orphan.refKind, "message");
    assert.equal(orphan.callId, "unknown");
    assert.equal((await readMessage({ ref: orphan.ref, before: 0, after: 0 })).messages[0]!.id, "orphan");
    assert.equal(searchConversation(conversation, { query: "validation failed", scope: "all" }).matched, 1, "results are not duplicated as message hits");
    assert.equal(searchConversation(conversation, { query: "parser", scope: "all", roles: ["user"] }).matched, 0);
  }));

  it("treats metacharacters literally and handles Unicode case matching without shifted offsets", async () => temporary(async file => {
    await writeFile(file, jsonl([piRecords[0], msg("u", "user", text("😀İ Straße K TEST a.*[b] İ"))]));
    const conversation = await loadConversation(file);
    assert.equal(searchConversation(conversation, { query: ".*" }).rows[0]!.match.offset, 18);
    assert.equal(searchConversation(conversation, { query: ".*", ignoreCase: true }).matched, 1);
    assert.equal(searchConversation(conversation, { query: "test" }).matched, 0);
    const hit = searchConversation(conversation, { query: "test", ignoreCase: true }).rows[0]!;
    assert.equal(Array.from(conversation.messages[0]!.text).slice(hit.match.offset, hit.match.offset + hit.match.chars).join(""), "TEST");
    assert.equal(searchConversation(conversation, { query: "k", ignoreCase: true }).rows[0]!.match.chars, 1);
    assert.equal(searchConversation(conversation, { query: "[missing]", ignoreCase: true }).matched, 0);
  }));

  it("does not substitute thinking, binary content, or arguments for conversation text", async () => temporary(async file => {
    const conversation = await loadConversation(file);
    for (const query of ["SECRET THINKING", "SECRET IMAGE", "SECRET ARGUMENT"]) assert.equal(searchConversation(conversation, { query, scope: "all", roles: "all" }).matched, 0);
    assert.equal(searchConversation(conversation, { query: "System policy" }).matched, 0);
    assert.equal(searchConversation(conversation, { query: "System policy", roles: ["system"] }).matched, 1);
    assert.deepEqual(listMessages(conversation, { offset: 3, limit: 1 }).rows.map(row => row.id), ["a2"]);
    assert.equal(searchConversation(conversation, { query: "absent" }).nextOffset, null);
  }));

  it("pins raw file identity and refuses stale, malformed, or conflicting references", async () => temporary(async (file, root) => {
    const first = listMessages(await loadConversation(file)).rows[0]!;
    const other = join(root, "same-id.jsonl");
    await writeFile(other, jsonl(piRecords));
    assert.notEqual(first.ref, listMessages(await loadConversation(other)).rows[0]!.ref);
    await assert.rejects(readMessage({ ref: "bad" }), /Invalid message reference/);
    await assert.rejects(readMessage({ ref: first.ref, session: file }), /--ref alone/);
    await assert.rejects(readMessage({ session: file, seq: 999 }), /not found/);
    await assert.rejects(readMessage({ ref: first.ref, before: 11 }), /--before/);
    await assert.rejects(readMessage({ ref: first.ref, textOffset: 999 }), /exceeds/);
    await writeFile(file, (await readFile(file, "utf8")) + "\n");
    await assert.rejects(readMessage({ ref: first.ref }), /Stale message reference/);
    const refreshed = listMessages(await loadConversation(file)).rows[0]!.ref;
    assert.equal((await readMessage({ ref: refreshed, before: 0, after: 0 })).messages[0]!.id, "u1");
  }));
});

describe("conversation source conversion", () => {
  it("locates text and command hits in their actual merged Claude source blocks", async () => temporary(async file => {
    const header = { sessionId: "claude", cwd: "/work/project" };
    await writeFile(file, jsonl([
      { ...header, type: "user", uuid: "u", message: { content: "Review it" } },
      { ...header, type: "assistant", message: { id: "merged", content: [{ type: "text", text: "First block." }] } },
      { ...header, type: "assistant", message: { id: "merged", content: [{ type: "tool_use", id: "test", name: "Bash", input: { command: "npm test" } }] } },
      { ...header, type: "assistant", message: { id: "merged", content: [{ type: "text", text: "Later decision: local Open." }] } },
      { ...header, type: "assistant", isSidechain: true, message: { id: "side", content: [{ type: "text", text: "sidechain only" }] } },
      { ...header, type: "user", isMeta: true, message: { content: "injected meta" } },
      { ...header, type: "user", uuid: "r", message: { content: [{ type: "tool_result", tool_use_id: "test", content: "passed" }] } },
    ]));
    const conversation = await loadConversation(file);
    assert.equal(listMessages(conversation).matched, 2);
    const hit = searchConversation(conversation, { query: "Later decision" }).rows[0]!;
    assert.equal(hit.line, 4);
    assert.equal(hit.sources.length, 1);
    const raw = await readFile(file);
    const source = hit.sources[0]!;
    assert.match(raw.subarray(source.byteStart, source.byteEnd).toString(), /Later decision/);
    const window = await readMessage({ ref: hit.messageRef, before: 0, after: 0 });
    assert.equal(window.messages[0]!.line, 2);
    assert.equal(window.messages[0]!.text.text, "First block.\nLater decision: local Open.");
    const command = searchConversation(conversation, { query: "npm test", scope: "commands" }).rows[0]!;
    assert.equal(command.line, 3);
    assert.equal((await readCall({ ref: command.ref })).call.callId, "test");
    const cross = searchConversation(conversation, { query: "block.\nLater" }).rows[0]!;
    assert.deepEqual(cross.sources.map(source => source.line), [2, 4]);
    for (const query of ["sidechain only", "injected meta"]) assert.equal(searchConversation(conversation, { query, roles: "all" }).matched, 0);
  }));

  it("preserves Codex channels and call links without echoing event prompts or reasoning blocks", async () => temporary(async file => {
    await writeFile(file, jsonl([
      { type: "session_meta", payload: { id: "codex", cwd: "/work/project" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Keep local Open" }] } },
      { type: "event_msg", payload: { type: "user_message", message: "Keep local Open" } },
      { type: "response_item", payload: { type: "reasoning", summary: [{ text: "secret reasoning" }] } },
      { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "test", arguments: '{"cmd":"npm test"}' } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "test", output: '{"exit_code":1,"output":"parser failed"}' } },
      { type: "response_item", payload: { type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text: "Kept local Open" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", channel: "analysis", content: [{ type: "output_text", text: "Analysis channel text" }] } },
    ]));
    const conversation = await loadConversation(file);
    assert.equal(searchConversation(conversation, { query: "Keep local Open" }).matched, 1);
    assert.equal(searchConversation(conversation, { query: "secret reasoning", roles: "all" }).matched, 0);
    const hit = searchConversation(conversation, { query: "Kept" }).rows[0]!;
    assert.equal(hit.channel, "final");
    assert.equal(searchConversation(conversation, { query: "Analysis channel" }).rows[0]!.channel, "analysis");
    const result = searchConversation(conversation, { query: "parser failed", scope: "results" }).rows[0]!;
    assert.equal((await readCall({ ref: result.ref })).call.isError, true);
    assert.equal((await readMessage({ ref: result.messageRef })).source, "codex");
  }));
});

const agentsBlock = "# AGENTS.md instructions for /work/project\n\n<INSTRUCTIONS>\n# Project rules\n\n- Run `npm test` before committing.\n- Never commit fixtures copied from real sessions.\n</INSTRUCTIONS>";
const skillBlock = "<skill name=\"release-notes\" location=\"/work/project/.agents/skills/release-notes/SKILL.md\">\n---\nname: release-notes\n---\nSummarize merged changes by area.\n</skill>\n\nWrite notes for v2";
const longReply = (label: string) => `${label} findings:\n${Array.from({ length: 600 }, (_, i) => `- item ${i}: the parser keeps the original bytes`).join("\n")}\nEnd of ${label} review.`;
const kindsOf = (conversation: Awaited<ReturnType<typeof loadConversation>>) =>
  listMessages(conversation, { roles: "all", limit: 100 }).rows.map(row => [row.role, row.kind]);

describe("message kinds and full text by source", () => {
  it("classifies Pi system, skill-expansion and typed prompts and returns a long reply whole", async () => temporary(async file => {
    const reply = longReply("Pi");
    await writeFile(file, jsonl([
      { type: "session", id: "pi-kinds", cwd: "/work/project" },
      msg("s", "system", [], { sections: { rules: "System policy" } }),
      msg("u1", "user", text(skillBlock)),
      msg("a1", "assistant", text("Drafting")),
      msg("u2", "user", text("the release notes miss the parser fix")),
      msg("a2", "assistant", [...text(reply), { type: "toolCall", id: "t", name: "bash", arguments: { command: "git log" } }]),
      msg("r", "toolResult", text("abc123 parser fix"), { toolCallId: "t" }),
    ]));
    const conversation = await loadConversation(file);
    assert.deepEqual(kindsOf(conversation), [["system", "injected"], ["user", "skill-expansion"], ["assistant", "agent"], ["user", "human"], ["assistant", "agent"], ["toolResult", "tool"]]);
    assert.deepEqual(listMessages(conversation, { kinds: ["human"] }).rows.map(row => row.id), ["u2"]);
    const whole = listMessages(conversation, { kinds: ["agent"], full: true }).rows.find(row => row.id === "a2")!;
    assert.equal(whole.text.text, reply);
    assert.equal(whole.text.truncated, false);
    assert.ok(whole.text.totalChars > 4096);
    const hit = searchConversation(conversation, { query: "release", kinds: ["skill-expansion"] }).rows[0]!;
    assert.equal(hit.messageKind, "skill-expansion");
    assert.equal(searchConversation(conversation, { query: "release", kinds: ["human"] }).matched, 1, "only the typed prompt");
    assert.equal(searchConversation(conversation, { query: "git log", scope: "commands" }).rows[0]!.messageKind, "agent");
  }));

  it("classifies Claude Code prompts from structure, keeps meta entries out, and merges a long reply whole", async () => temporary(async file => {
    const header = { sessionId: "claude-kinds", cwd: "/work/project" };
    const reply = longReply("Claude");
    const half = Math.floor(reply.length / 2);
    await writeFile(file, jsonl([
      { ...header, type: "user", uuid: "u1", promptId: "p1", message: { content: "why did the parser test break?" } },
      { ...header, type: "user", uuid: "m1", isMeta: true, message: { content: [{ type: "text", text: "Base directory for this skill: /work/project/.claude/skills/review\n\nReview carefully." }] } },
      { ...header, type: "user", uuid: "n1", origin: { kind: "task-notification" }, message: { content: "<task-notification>\n<status>completed</status>\n</task-notification>" } },
      { ...header, type: "assistant", message: { id: "a", content: [{ type: "text", text: reply.slice(0, half) }] } },
      { ...header, type: "assistant", message: { id: "a", content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "npm test" } }] } },
      { ...header, type: "assistant", message: { id: "a", content: [{ type: "text", text: reply.slice(half) }] } },
      { ...header, type: "user", uuid: "r", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "1 failing" }] } },
      { ...header, type: "user", uuid: "u2", promptId: "p2", message: { content: "Context handoff (full_thread_summary):\nPrevious thread summary goes here." } },
    ]));
    const conversation = await loadConversation(file);
    assert.deepEqual(kindsOf(conversation), [["user", "human"], ["assistant", "agent"], ["toolResult", "tool"], ["user", "injected"]]);
    const whole = listMessages(conversation, { kinds: ["agent"], full: true }).rows[0]!;
    assert.equal(whole.text.text, `${reply.slice(0, half)}\n${reply.slice(half)}`, "merged text blocks join with a newline");
    assert.equal(whole.text.totalChars, Array.from(reply).length + 1);
  }));

  it("classifies Codex AGENTS.md, replayed and developer items as injected and echoed inputs as submitted", async () => temporary(async file => {
    const reply = longReply("Codex");
    const user = (value: string) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: value }] } });
    const echo = (value: string) => ({ type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", id: value.length, content: [{ type: "text", text: value, text_elements: [] }] } } });
    await writeFile(file, jsonl([
      { type: "session_meta", payload: { id: "codex-kinds", cwd: "/work/project" } },
      { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>sandboxed</permissions instructions>" }] } },
      user(agentsBlock),
      user("<environment_context>\n  <cwd>/work/project</cwd>\n</environment_context>"),
      user("review the parser change"), echo("review the parser change"),
      { type: "response_item", payload: { type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text: reply }] } },
      user("Background command completed (exit 0): npm test"), echo("Background command completed (exit 0): npm test"),
      user("[Historical user; user_message; thread=t1]\nreview the parser change"),
    ]));
    const conversation = await loadConversation(file);
    assert.deepEqual(kindsOf(conversation), [["developer", "injected"], ["user", "injected"], ["user", "human"], ["assistant", "agent"], ["user", "notification"], ["user", "injected"]]);
    assert.deepEqual(listMessages(conversation, { kinds: ["human"], full: true }).rows.map(row => row.text.text), ["review the parser change"]);
    assert.equal(listMessages(conversation, { kinds: ["agent"], full: true }).rows[0]!.text.text, reply);
    const agents = searchConversation(conversation, { query: "AGENTS.md" }).rows[0]!;
    assert.equal(agents.messageKind, "injected");
  }));

  it("reports unknown, not human, for Codex inputs when the file records no input echoes", async () => temporary(async file => {
    await writeFile(file, jsonl([
      { type: "session_meta", payload: { id: "codex-legacy", cwd: "/work/project" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: agentsBlock }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix the flaky test" }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: skillBlock }] } },
    ]));
    assert.deepEqual(kindsOf(await loadConversation(file)), [["user", "injected"], ["user", "unknown"], ["user", "skill-expansion"]]);
  }));
});

describe("conversation CLI", () => {
  it("runs discovery-compatible search, projection, pagination and neighborhood expansion", async () => temporary(async (file, root) => {
    const first = cli("search", "--root", root, "--source", "all", "--query", "local", "--limit", "1", "--text-limit", "18", "--page");
    assert.equal(first.status, 0, first.stderr);
    const page = JSON.parse(first.stdout);
    assert.equal(page.matched, 2);
    assert.equal(page.nextOffset, 1);
    assert.equal(page.complete, true);
    assert.ok(page.rows[0].excerpt.text.includes("local"));
    const expanded = cli("message", "--ref", page.rows[0].messageRef, "--before", "1", "--after", "1", "--limit", "25");
    assert.equal(expanded.status, 0, expanded.stderr);
    assert.equal(JSON.parse(expanded.stdout).messages.length, 3);
    const second = cli("search", file, "--query", "local", "--offset", "1", "--limit", "1", "--fields", "kind,line", "--format", "tsv");
    assert.equal(second.stdout, "kind\tline\nmessage\t7\n");
    const listing = cli("messages", file, "--role", "user", "--fields", "seq,role", "--format", "json");
    assert.deepEqual(JSON.parse(listing.stdout), [{ seq: 2, role: "user" }, { seq: 5, role: "user" }]);
    assert.equal(cli("messages", file, "--limit", "1", "--fields", "role").stdout, '{"role":"user"}\n');
    assert.equal(cli("search", file, "--query", "CORRECTION", "--ignore-case", "--fields", "line").stdout, '{"line":6}\n');
    assert.deepEqual(JSON.parse(cli("messages", file, "--kind", "human", "--fields", "seq,kind", "--format", "json").stdout), [{ seq: 2, kind: "human" }, { seq: 5, kind: "human" }]);
    assert.equal(cli("search", file, "--query", "local", "--kind", "agent", "--fields", "messageKind,line", "--format", "tsv").stdout, "messageKind\tline\nagent\t7\n");
  }));

  it("paginates across files and exposes partial failures beyond the returned page", async () => temporary(async (file, root) => {
    const second = join(root, "second.jsonl");
    await writeFile(second, jsonl(piRecords));
    const query = ["search", file, second, "--query", "Correction", "--offset", "1", "--limit", "1", "--page"];
    const page = JSON.parse(cli(...query).stdout);
    assert.equal(page.matched, 2);
    assert.equal(page.rows[0].path, second);
    assert.equal(page.nextOffset, null);
    await writeFile(second, "{bad\n");
    const partial = cli("search", file, second, "--query", "Correction", "--limit", "1", "--page");
    assert.equal(partial.status, 1);
    const value = JSON.parse(partial.stdout);
    assert.equal(value.rows.length, 1);
    assert.equal(value.complete, false);
    assert.equal(value.readSources, 1);
    assert.equal(value.failedSources[0].path, second);
    assert.match(partial.stderr, /1 of 2 sessions/);
  }));

  it("validates inputs, supports empty results and advertises every schema", async () => temporary(async file => {
    for (const args of [
      ["search", file], ["search", file, "--query", ""], ["search", file, "--query", "x", "--in", "typo"],
      ["messages", file, "--role", "typo"], ["messages", file, "--role", "user,user"], ["messages", file, "--offset", "-1"],
      ["messages", file, "--limit", "0"], ["messages", file, "--text-limit", "5000"], ["messages", file, "--fields", "typo"],
      ["messages", file, "--query", "x"], ["messages", file, "--kind", "typo"], ["messages", file, "--kind", "human,human"],
      ["message", file, "--seq", "2", "--kind", "human"], ["messages", file, "--page", "--format", "jsonl"],
      ["message", file, "--seq", "2", "--role", "user"], ["message", file, "--seq", "2", "--format", "text"],
    ]) { const response = cli(...args); assert.equal(response.status, 1, args.join(" ")); assert.equal(response.stdout, ""); }
    const empty = JSON.parse(cli("search", file, "--query", "absent", "--page").stdout);
    assert.equal(empty.matched, 0);
    assert.equal(empty.nextOffset, null);
    assert.deepEqual(empty.rows, []);
    for (const command of ["message", "messages", "search"]) {
      assert.equal(cli(command, "--help").status, 0);
      const schema = cli("schema", command, "--format", "json");
      assert.equal(schema.status, 0, schema.stderr);
      assert.ok(JSON.parse(schema.stdout)[command].fields.length > 5);
    }
    const schemas = JSON.parse(cli("schema", "--format", "json").stdout);
    for (const command of ["call", "message", "messages", "search"]) assert.ok(schemas[command]);
  }));
});
