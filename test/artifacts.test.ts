import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BLOB_THRESHOLD_BYTES, extractArtifacts } from "../src/artifacts/extract.js";
import { ingestSessionFile } from "../src/store/ingest-session.js";
import { normalizeSnapshot } from "../src/normalize/normalize.js";

const header = { type: "session", version: 3, id: "artifacts-session", timestamp: "2026-08-04T00:00:00.000Z", cwd: "/tmp/example" };

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function message(id: string, parentId: string | null, role: string, content: unknown, extra: Record<string, unknown> = {}): unknown {
  return { type: "message", id, parentId, timestamp: "2026-08-04T00:00:00.000Z", message: { role, content, ...extra } };
}

function toolCall(id: string, name: string, args: unknown): unknown {
  return { type: "toolCall", id, name, arguments: args };
}

interface SessionShape {
  entries: unknown[];
}

function buildFixture(): SessionShape {
  const readCall = message("a1", "u1", "assistant", [toolCall("read-1", "read", { path: "README.md", limit: 120 })]);
  const readResult = message("r1", "a1", "toolResult", [{ type: "text", text: "README content…" }], { toolCallId: "read-1", toolName: "read", isError: false });
  const editCall = message("a2", "r1", "assistant", [toolCall("edit-1", "edit", { path: "src/a.ts", edits: [{ oldText: "old line", newText: "new line" }] })]);
  const editResult = message("r2", "a2", "toolResult", [{ type: "text", text: "ok" }], { toolCallId: "edit-1", toolName: "edit", isError: false });
  const writeCall = message("a3", "r2", "assistant", [toolCall("write-1", "write", { path: "src/new.ts", content: "export const x = 1;\n" })]);
  const writeResult = message("r3", "a3", "toolResult", [{ type: "text", text: "written" }], { toolCallId: "write-1", toolName: "write", isError: false });
  const testCall = message("a4", "r3", "assistant", [toolCall("test-1", "bash", { command: "npm test" })]);
  const testResult = message("r4", "a4", "toolResult", [{ type: "text", text: "pass 30/30" }], { toolCallId: "test-1", toolName: "bash", isError: false });
  const failCall = message("a5", "r4", "assistant", [toolCall("fail-1", "bash", { command: "npm run typecheck" })]);
  const failResult = message("r5", "a5", "toolResult", [{ type: "text", text: "tsc: error TS2304" }], { toolCallId: "fail-1", toolName: "bash", isError: true });
  const installCall = message("a6", "r5", "assistant", [toolCall("install-1", "bash", { command: "npm install" })]);
  const installResult = message("r6", "a6", "toolResult", [{ type: "text", text: "added 12 packages" }], { toolCallId: "install-1", toolName: "bash", isError: false });
  const searchCall = message("a7", "r6", "assistant", [toolCall("web-1", "web", { query: "pi session format" })]);
  const searchResult = message("r7", "a7", "toolResult", [{ type: "text", text: "results" }], { toolCallId: "web-1", toolName: "web", isError: false });
  const unknownCall = message("a8", "r7", "assistant", [toolCall("notes-1", "notes", { query: "foo" })]);
  const orphanRead = message("a9", "r7", "assistant", [toolCall("read-orphan", "read", { path: "docs/x.md" })]);
  return {
    entries: [header, readCall, readResult, editCall, editResult, writeCall, writeResult, testCall, testResult, failCall, failResult, installCall, installResult, searchCall, searchResult, unknownCall, orphanRead],
  };
}

async function prepare(root: string, fixture: SessionShape): Promise<{ store: string; sessionId: string }> {
  const store = join(root, "store");
  const source = join(root, "session.jsonl");
  await writeFile(source, fixture.entries.map(line).join(""));
  const ingested = await ingestSessionFile(source, store);
  await normalizeSnapshot({ store, sessionId: ingested.sessionId });
  return { store, sessionId: ingested.sessionId };
}

const artifactsDirectory = (snapshot: string): string => join(snapshot, "artifacts");

async function rows<T>(path: string): Promise<T[]> {
  const text = await readFile(path, "utf8");
  return text.split("\n").filter((entry) => entry.trim().length > 0).map((entry) => JSON.parse(entry) as T);
}

describe("artifact extraction", () => {
  it("extracts file reads with requested range and returned bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-artifacts-"));
    const { store, sessionId } = await prepare(root, buildFixture());
    const result = await extractArtifacts({ store, sessionId });
    assert.equal(result.counts.fileReads, 2);
    const reads = await rows<Record<string, unknown>>(join(artifactsDirectory(result.snapshot), "file-reads.jsonl"));
    const read = reads.find((entry) => entry.toolCallId === "read-1");
    assert.equal(read?.path, "README.md");
    assert.deepEqual(read?.requestedRange, { limit: 120 });
    assert.equal(read?.returnedBytes, Buffer.byteLength("README content…"));
    assert.equal(read?.succeeded, true);
    assert.equal((read?.source as { line: number }).line, 2);
  });

  it("records mutation patches as observed only when arguments contain before and after text", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-artifacts-"));
    const { store, sessionId } = await prepare(root, buildFixture());
    const result = await extractArtifacts({ store, sessionId });
    assert.equal(result.counts.fileMutations, 2);
    const mutations = await rows<Record<string, unknown>>(join(artifactsDirectory(result.snapshot), "file-mutations.jsonl"));
    const edit = mutations.find((entry) => entry.toolCallId === "edit-1");
    assert.equal(edit?.operation, "edit");
    assert.equal((edit?.patch as { observed: boolean }).observed, true);
    assert.equal((edit?.patch as { exact: boolean }).exact, false);
    const write = mutations.find((entry) => entry.toolCallId === "write-1");
    assert.equal(write?.operation, "write");
    assert.equal(write?.content, "export const x = 1;\n");
    assert.match((write?.patch as { reason: string }).reason, /prior file state/);
  });

  it("classifies commands deterministically and derives test runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-artifacts-"));
    const { store, sessionId } = await prepare(root, buildFixture());
    const result = await extractArtifacts({ store, sessionId });
    assert.equal(result.counts.commands, 3);
    assert.equal(result.counts.tests, 1);
    const commands = await rows<Record<string, unknown>>(join(artifactsDirectory(result.snapshot), "commands.jsonl"));
    const test = commands.find((entry) => entry.toolCallId === "test-1");
    const classifications = test?.classifications as Array<{ name: string; reason: string; version: number }>;
    assert.deepEqual(classifications.map((classification) => classification.name), ["test"]);
    assert.equal(classifications[0]?.version, 2);
    assert.equal((test?.result as { isError: boolean }).isError, false);
    const typecheck = commands.find((entry) => entry.toolCallId === "fail-1");
    assert.deepEqual((typecheck?.classifications as Array<{ name: string }>).map((classification) => classification.name), ["typecheck"]);
    assert.equal((typecheck?.result as { isError: boolean }).isError, true);
    const install = commands.find((entry) => entry.toolCallId === "install-1");
    assert.deepEqual((install?.classifications as Array<{ name: string }>).map((classification) => classification.name), ["dependency"]);
    const tests = await rows<Record<string, unknown>>(join(artifactsDirectory(result.snapshot), "tests.jsonl"));
    assert.equal(tests[0]?.toolCallId, "test-1");
  });

  it("keeps unknown tools and orphans visible in generic records", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-artifacts-"));
    const { store, sessionId } = await prepare(root, buildFixture());
    const result = await extractArtifacts({ store, sessionId });
    assert.equal(result.counts.unknownTools, 1);
    assert.equal(result.counts.missingResults, 2);
    const unknown = await rows<Record<string, unknown>>(join(artifactsDirectory(result.snapshot), "unknown-tools.jsonl"));
    assert.equal(unknown[0]?.toolName, "notes");
    assert.equal(unknown[0]?.toolCallId, "notes-1");
    const reads = await rows<Record<string, unknown>>(join(artifactsDirectory(result.snapshot), "file-reads.jsonl"));
    const orphan = reads.find((entry) => entry.toolCallId === "read-orphan");
    assert.equal(orphan?.succeeded, null);
  });

  it("references large command output and write bodies through blobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-artifacts-"));
    const fixture = buildFixture();
    const big = "y".repeat(BLOB_THRESHOLD_BYTES + 1);
    fixture.entries.push(
      message("a10", "r7", "assistant", [toolCall("big-cmd", "bash", { command: "cat big.log" })]),
      message("r10", "a10", "toolResult", [{ type: "text", text: big }], { toolCallId: "big-cmd", toolName: "bash", isError: false }),
      message("a11", "r10", "assistant", [toolCall("big-write", "write", { path: "src/big.ts", content: big })]),
      message("r11", "a11", "toolResult", [{ type: "text", text: "ok" }], { toolCallId: "big-write", toolName: "write", isError: false }),
    );
    const { store, sessionId } = await prepare(root, fixture);
    const result = await extractArtifacts({ store, sessionId });
    const commands = await rows<Record<string, unknown>>(join(artifactsDirectory(result.snapshot), "commands.jsonl"));
    const bigCommand = commands.find((entry) => entry.toolCallId === "big-cmd");
    const commandResult = bigCommand?.result as { output: unknown; outputBytes: number; blobs: Array<{ blob: string; bytes: number }> };
    assert.equal(commandResult.outputBytes, BLOB_THRESHOLD_BYTES + 1);
    assert.equal(commandResult.blobs.length, 1);
    assert.equal(commandResult.blobs[0]?.bytes, BLOB_THRESHOLD_BYTES + 1);
    const mutations = await rows<Record<string, unknown>>(join(artifactsDirectory(result.snapshot), "file-mutations.jsonl"));
    const bigWrite = mutations.find((entry) => entry.toolCallId === "big-write");
    assert.equal(bigWrite?.operation, "write");
    assert.equal(bigWrite?.path, "src/big.ts");
    const content = bigWrite?.content as { blob: string; bytes: number };
    assert.equal(content.bytes, BLOB_THRESHOLD_BYTES + 1);
    const blob = await readFile(join(store, "blobs", "sha256", content.blob.slice(0, 2), content.blob), "utf8");
    assert.equal(blob, big);
  });

  it("is idempotent and deterministic", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-artifacts-"));
    const { store, sessionId } = await prepare(root, buildFixture());
    await extractArtifacts({ store, sessionId });
    const snapshot = (await extractArtifacts({ store, sessionId })).snapshot;
    const names = ["file-reads.jsonl", "file-mutations.jsonl", "searches.jsonl", "commands.jsonl", "tests.jsonl", "unknown-tools.jsonl", "derived-artifacts.json"];
    const before = await Promise.all(names.map((name) => readFile(join(artifactsDirectory(snapshot), name), "utf8").catch(() => readFile(join(snapshot, name), "utf8"))));
    await extractArtifacts({ store, sessionId });
    const after = await Promise.all(names.map((name) => readFile(join(artifactsDirectory(snapshot), name), "utf8").catch(() => readFile(join(snapshot, name), "utf8"))));
    assert.deepEqual(after, before);
  });
});