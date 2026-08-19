import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BLOB_THRESHOLD_BYTES, normalizeSnapshot } from "../src/normalize/normalize.js";
import { ingestSessionFile } from "../src/store/ingest-session.js";

const header = { type: "session", version: 3, id: "schema-session", timestamp: "2026-08-04T00:00:00.000Z", cwd: "/tmp/example" };

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function message(id: string, parentId: string | null, role: string, content: unknown, extra: Record<string, unknown> = {}): unknown {
  return { type: "message", id, parentId, timestamp: "2026-08-04T00:00:00.000Z", message: { role, content, ...extra } };
}

function thinkingBlock(thinking: string, signature?: unknown): unknown {
  return signature === undefined ? { type: "thinking", thinking } : { type: "thinking", thinking, thinkingSignature: signature };
}

const IMAGE_TEXT = "Read image file [image/png]\n[Image: original 2553x1392, displayed at 2000x1090]";

async function prepare(root: string, entries: unknown[]): Promise<{ store: string; sessionId: string; snapshot: string }> {
  const store = join(root, "store");
  const source = join(root, "session.jsonl");
  await writeFile(source, entries.map(line).join(""));
  const ingested = await ingestSessionFile(source, store);
  const result = await normalizeSnapshot({ store, sessionId: ingested.sessionId });
  return { store, sessionId: ingested.sessionId, snapshot: result.snapshot };
}

async function rows<T>(path: string): Promise<T[]> {
  const text = await readFile(path, "utf8");
  return text.split("\n").filter((entry) => entry.trim().length > 0).map((entry) => JSON.parse(entry) as T);
}

describe("schema variants from the Omakase corpus", () => {
  it("preserves image, thinking, and toolCall content blocks", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-schema-"));
    const assistant = message("a1", "u1", "assistant", [
      { type: "text", text: "reading" },
      { type: "image", path: "/tmp/shots/cube.png", mime: "image/png" },
      thinkingBlock("I need to inspect the CSS pointer.", { id: "rs_01abc", type: "reasoning", content: [] }),
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/styles.css", limit: 40 } },
    ]);
    const { store, sessionId, snapshot } = await prepare(root, [header, assistant]);

    const entries = await rows<Record<string, unknown>>(join(snapshot, "records", "entries.jsonl"));
    assert.equal(entries.find((entry) => entry.id === "a1")?.type, "message");
    const messages = await rows<Record<string, unknown>>(join(snapshot, "records", "messages.jsonl"));
    const record = messages.find((messageRow) => messageRow.entryId === "a1");
    assert.equal(record?.hasThinking, true);
    assert.equal(record?.hasToolCalls, true);
    assert.match(String(record?.text), /reading/);
    assert.doesNotMatch(String(record?.text), /cube\.png/);

    // Image blocks stay structural and queryable in entries data.
    const entryData = entries.find((entry) => entry.id === "a1")?.data as { message: { content: Array<Record<string, unknown>> } };
    const image = entryData.message.content.find((block) => block.type === "image");
    assert.equal(image?.path, "/tmp/shots/cube.png");
    const thinking = entryData.message.content.find((block) => block.type === "thinking");
    assert.match(String((thinking?.thinkingSignature as { id: string }).id), /^rs_/);
  });

  it("preserves message diagnostics such as provider_transport_failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-schema-"));
    const diagnosticsMessage = message(
      "a1",
      "u1",
      "assistant",
      [{ type: "text", text: "retrying chat connection" }],
      {
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        stopReason: "toolUse",
        timestamp: 1780698650057,
        diagnostics: [
          { type: "provider_transport_failure", timestamp: 1780698677329, error: { name: "WebSocketCloseError", message: "connection closed" } },
        ],
      },
    );
    const { snapshot } = await prepare(root, [header, diagnosticsMessage]);
    const entries = await rows<Record<string, unknown>>(join(snapshot, "records", "entries.jsonl"));
    const entry = entries.find((row) => row.id === "a1")?.data as { message: { diagnostics: Array<Record<string, unknown>> } };
    assert.equal(entry.message.diagnostics.length, 1);
    assert.equal(entry.message.diagnostics[0]?.type, "provider_transport_failure");
    assert.equal((entry.message.diagnostics[0]?.error as { name: string }).name, "WebSocketCloseError");
    const invocations = await rows<Record<string, unknown>>(join(snapshot, "records", "tool-invocations.jsonl"));
    assert.equal(invocations.length, 0);
  });

  it("deblobs an oversized thinking block and keeps the entry queryable", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-schema-"));
    const bigThinking = "t".repeat(BLOB_THRESHOLD_BYTES + 1);
    const assistant = message("a1", "u1", "assistant", [thinkingBlock(bigThinking)]);
    const { store, sessionId, snapshot } = await prepare(root, [header, assistant]);

    const result = await normalizeSnapshot({ store, sessionId });
    assert.equal(result.counts.blobs, 1);
    const entries = await rows<Record<string, unknown>>(join(snapshot, "records", "entries.jsonl"));
    const content = (entries.find((entry) => entry.id === "a1")?.data as { message: { content: Array<Record<string, unknown>> } }).message.content[0];
    assert.equal(content?.type, "blob"); // oversized non-text blocks keep their source type, labels are applied
    assert.equal(content?.sourceType, "thinking");
    const blob = (content?.blob as string) ?? "";
    const blobText = await readFile(join(store, "blobs", "sha256", blob.slice(0, 2), blob), "utf8");
    assert.equal(blobText, JSON.stringify({ type: "thinking", thinking: bigThinking }));
  });

  it("handles an empty toolResult body and a rewind-turn custom entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-schema-"));
    const rewind = { type: "custom", id: "r1", parentId: "c1", timestamp: "2026-08-04T00:00:00.000Z", customType: "rewind-turn", data: { v: 2, snapshots: ["abc"] } };
    const emptyResult = message("er1", "a1", "toolResult", [], { toolCallId: "c1", toolName: "bash", isError: true });
    const { store, sessionId } = await prepare(root, [header, rewind, emptyResult]);
    const result = await normalizeSnapshot({ store, sessionId });
    assert.equal(result.counts.toolResults, 1);
    assert.equal(result.orphans.results, 1, "a result with no matching call stays visible as an orphan");
    const entries = await rows<Record<string, unknown>>(join(result.snapshot, "records", "entries.jsonl"));
    assert.equal(entries.find((entry) => entry.id === "r1")?.type, "custom");
  });
});
