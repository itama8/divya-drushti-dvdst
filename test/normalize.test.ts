import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BLOB_THRESHOLD_BYTES, normalizeSnapshot } from "../src/normalize/normalize.js";
import { ingestSessionFile } from "../src/store/ingest-session.js";
import { readSessionSnapshot } from "../src/store/read-session.js";

const header = { type: "session", version: 3, id: "normalize-session", timestamp: "2026-08-04T00:00:00.000Z", cwd: "/tmp/example" };
const modelChange = { type: "model_change", id: "m1", parentId: null, timestamp: "2026-08-04T00:00:01.000Z", provider: "openai-codex", modelId: "gpt-5.5" };
const thinkingChange = { type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: "2026-08-04T00:00:02.000Z", thinkingLevel: "medium" };
const userMessage = { type: "message", id: "u1", parentId: "t1", timestamp: "2026-08-04T00:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } };
const assistantMessage = {
  type: "message",
  id: "a1",
  parentId: "u1",
  timestamp: "2026-08-04T00:00:04.000Z",
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "running tests" },
      { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } },
    ],
  },
};
const resultMessage = {
  type: "message",
  id: "r1",
  parentId: "a1",
  timestamp: "2026-08-04T00:00:05.000Z",
  message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", isError: false, content: [{ type: "text", text: "pass 26/26" }] },
};
const compaction = { type: "compaction", id: "c1", parentId: null, timestamp: "2026-08-04T00:00:06.000Z", summary: "kept context" };
const branchSummary = { type: "branch_summary", id: "b1", parentId: "c1", timestamp: "2026-08-04T00:00:07.000Z", title: "abandoned path" };
const custom = { type: "custom", id: "x1", parentId: null, timestamp: "2026-08-04T00:00:08.000Z", custom: "payload" };
const label = { type: "label", id: "l1", parentId: null, timestamp: "2026-08-04T00:00:09.000Z", label: "wip" };
const sessionInfo = { type: "session_info", id: "s1", parentId: null, timestamp: "2026-08-04T00:00:10.000Z", info: "wrapped" };

const ALL_ENTRIES = [header, modelChange, thinkingChange, userMessage, assistantMessage, resultMessage, compaction, branchSummary, custom, label, sessionInfo];

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function sessionText(extra: unknown[] = []): string {
  return [...ALL_ENTRIES, ...extra].map(line).join("");
}

async function ingestFixture(root: string, text: string): Promise<{ store: string; sessionId: string }> {
  const store = join(root, "store");
  const source = join(root, "session.jsonl");
  await writeFile(source, text);
  const ingested = await ingestSessionFile(source, store);
  return { store, sessionId: ingested.sessionId };
}

const recordsDirectory = (snapshot: string): string => join(snapshot, "records");

describe("normalize snapshot", () => {
  it("normalizes all entry types with parent links and provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-normalize-"));
    const { store, sessionId } = await ingestFixture(root, sessionText());

    const result = await normalizeSnapshot({ store, sessionId });
    assert.equal(result.status, "complete");
    assert.equal(result.counts.entries, ALL_ENTRIES.length);
    assert.equal(result.counts.messages, 3);
    assert.equal(result.counts.toolInvocations, 1);
    assert.equal(result.counts.toolResults, 1);
    assert.equal(result.counts.timeline, ALL_ENTRIES.length);
    assert.equal(result.orphans.calls, 0);
    assert.equal(result.orphans.results, 0);

    const snapshot = result.snapshot;
    const entries = (await readFile(join(recordsDirectory(snapshot), "entries.jsonl"), "utf8")).trim().split("\n").map((entry) => JSON.parse(entry));
    assert.equal(entries.length, ALL_ENTRIES.length);
    assert.deepEqual(entries.map((entry) => entry.type), ["session", "model_change", "thinking_level_change", "message", "message", "message", "compaction", "branch_summary", "custom", "label", "session_info"]);
    assert.equal(entries[4]?.parentId, "u1");
    assert.equal(entries[3]?.parentId, "t1");
    assert.equal(entries[0]?.source.line, 1);
    assert.equal(entries[0]?.source.byteStart, 0);
    const timeline = (await readFile(join(recordsDirectory(snapshot), "timeline.jsonl"), "utf8")).trim().split("\n").map((record) => JSON.parse(record));
    assert.deepEqual(timeline.map((record) => record.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.deepEqual(timeline.map((record) => record.role).filter((role) => role !== undefined), ["user", "assistant", "toolResult"]);

    const snapshotInfo = await readSessionSnapshot({ store, sessionId });
    assert.equal(snapshotInfo.sourceHash, result.sourceHash);
    const derived = JSON.parse(await readFile(join(snapshot, "derived.json"), "utf8"));
    assert.equal(derived.extractor.name, "pi-normalize");
    assert.equal(derived.counts.toolInvocations, 1);
  });

  it("pairs tool calls with results and reports orphans", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-normalize-"));
    const orphanCall = { type: "message", id: "o1", parentId: "u1", timestamp: "2026-08-04T00:00:11.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call-orphan", name: "read", arguments: { path: "x.md" } }] } };
    const orphanResult = { type: "message", id: "o2", parentId: "a1", timestamp: "2026-08-04T00:00:12.000Z", message: { role: "toolResult", toolCallId: "call-missing", toolName: "bash", isError: true, content: [] } };
    const { store, sessionId } = await ingestFixture(root, sessionText([orphanCall, orphanResult]));

    const result = await normalizeSnapshot({ store, sessionId });
    assert.equal(result.counts.toolInvocations, 2);
    assert.equal(result.counts.toolResults, 2);
    assert.equal(result.orphans.calls, 1);
    assert.equal(result.orphans.results, 1);
    assert.ok(result.diagnostics.some((diagnostic) => /call-orphan/.test(diagnostic.message)));
    assert.ok(result.diagnostics.some((diagnostic) => /call-missing/.test(diagnostic.message)));

    const derived = JSON.parse(await readFile(join(result.snapshot, "derived.json"), "utf8"));
    assert.deepEqual(derived.orphans.calls, ["call-orphan"]);
    assert.deepEqual(derived.orphans.results, ["call-missing"]);
  });

  it("moves large payloads to the shared blob store", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-normalize-"));
    const big = "x".repeat(BLOB_THRESHOLD_BYTES + 1);
    const bigMessage = { type: "message", id: "big1", parentId: "u1", timestamp: "2026-08-04T00:00:11.000Z", message: { role: "assistant", content: [{ type: "text", text: big }] } };
    const { store, sessionId } = await ingestFixture(root, sessionText([bigMessage]));

    const result = await normalizeSnapshot({ store, sessionId });
    assert.equal(result.counts.blobs, 1);
    assert.equal(result.counts.blobBytes, BLOB_THRESHOLD_BYTES + 1);

    const messages = (await readFile(join(recordsDirectory(result.snapshot), "messages.jsonl"), "utf8")).trim().split("\n").map((entry) => JSON.parse(entry));
    const bigRecord = messages.find((message) => message.entryId === "big1");
    assert.equal(bigRecord.blobBlocks.length, 1);
    assert.equal(bigRecord.text, "");
    const blobRef = bigRecord.blobBlocks[0];
    const blobPath = join(store, "blobs", "sha256", blobRef.blob.slice(0, 2), blobRef.blob);
    assert.equal(await readFile(blobPath, "utf8"), big);

    const entries = (await readFile(join(recordsDirectory(result.snapshot), "entries.jsonl"), "utf8")).trim().split("\n").map((entry) => JSON.parse(entry));
    const bigEntry = entries.find((entry) => entry.id === "big1");
    assert.equal(bigEntry.data.message.content[0].blob, blobRef.blob);

    // A second message with the same payload shares the blob.
    const again = { type: "message", id: "big2", parentId: "u1", timestamp: "2026-08-04T00:00:12.000Z", message: { role: "assistant", content: [{ type: "text", text: big }] } };
    const root2 = await mkdtemp(join(tmpdir(), "dvdst-normalize-"));
    const { store: store2, sessionId: sessionId2 } = await ingestFixture(root2, sessionText([again]));
    const result2 = await normalizeSnapshot({ store: store2, sessionId: sessionId2 });
    assert.equal(result2.counts.blobs, 1);
  });

  it("is idempotent: re-normalizing rewrites identical records", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-normalize-"));
    const { store, sessionId } = await ingestFixture(root, sessionText());
    await normalizeSnapshot({ store, sessionId });
    const snapshotInfo = await readSessionSnapshot({ store, sessionId });
    const before = await Promise.all(
      ["entries.jsonl", "messages.jsonl", "tool-invocations.jsonl", "tool-results.jsonl", "timeline.jsonl", "derived.json"].map((name) => readFile(join(snapshotInfo.path, name === "derived.json" ? "derived.json" : `records/${name}`), "utf8")),
    );

    const again = await normalizeSnapshot({ store, sessionId });
    assert.equal(again.counts.entries, ALL_ENTRIES.length);
    const after = await Promise.all(
      ["entries.jsonl", "messages.jsonl", "tool-invocations.jsonl", "tool-results.jsonl", "timeline.jsonl", "derived.json"].map((name) => readFile(join(snapshotInfo.path, name === "derived.json" ? "derived.json" : `records/${name}`), "utf8")),
    );
    assert.deepEqual(after, before);
    assert.equal((await readdir(join(snapshotInfo.path, "records"))).length, 5);
  });
});