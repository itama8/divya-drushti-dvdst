import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ingestSessionFile } from "../src/store/ingest-session.js";
import { readSessionSnapshot } from "../src/store/read-session.js";

const header = { type: "session", version: 3, id: "fixture-session", timestamp: "2026-08-04T00:00:00.000Z", cwd: "/tmp/example" };
const modelChange = { type: "model_change", id: "m1", parentId: null, timestamp: "2026-08-04T00:00:01.000Z", provider: "openai-codex", modelId: "gpt-5.5" };
const userMessage = { type: "message", id: "u1", parentId: null, timestamp: "2026-08-04T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } };
const assistantMessage = {
  type: "message",
  id: "a1",
  parentId: "u1",
  timestamp: "2026-08-04T00:00:03.000Z",
  message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }] },
};
const label = { type: "label", id: "l1", parentId: null, timestamp: "2026-08-04T00:00:04.000Z", label: "wip" };

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function sessionText(extra: unknown[] = []): string {
  return [header, modelChange, userMessage, assistantMessage, label, ...extra].map(line).join("");
}

function sessionDirectory(store: string): string {
  return join(store, "sessions", "pi", "fixture-session");
}

describe("session ingestion store", () => {
  it("preserves the raw source and writes a complete manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-session-"));
    const store = join(root, "store");
    const source = join(root, "session.jsonl");
    await writeFile(source, sessionText());

    const result = await ingestSessionFile(source, store);
    assert.equal(result.status, "ingested");
    assert.equal(result.manifestStatus, "complete");
    assert.equal(result.change.class, "initial");
    assert.equal(result.sessionId, "fixture-session");
    assert.match(result.sourceHash, /^[a-f0-9]{64}$/);
    assert.equal(await readFile(join(result.snapshot, "source", "raw.jsonl"), "utf8"), sessionText());
    assert.equal(JSON.parse(await readFile(join(store, "store.json"), "utf8")).schemaVersion, 1);
    assert.equal(JSON.parse(await readFile(join(result.snapshot, "source", "source-state.json"), "utf8")).complete, true);

    const manifest = JSON.parse(await readFile(join(result.snapshot, "manifest.json"), "utf8"));
    assert.equal(manifest.adapter.name, "pi");
    assert.equal(manifest.status, "complete");
    assert.equal(manifest.source.sha256, result.sourceHash);
    assert.equal(manifest.source.sessionId, "fixture-session");
    assert.equal(manifest.source.version, 3);
    assert.equal(manifest.counts.entries, 5);
    assert.equal(manifest.counts.byType.message, 2);
    assert.equal(manifest.counts.byType.session, 1);
    assert.equal(manifest.diagnostics.length, 0);

    const latest = JSON.parse(await readFile(join(sessionDirectory(store), "latest.json"), "utf8"));
    assert.equal(latest.sourceHash, result.sourceHash);
    const loaded = await readSessionSnapshot({ store, sessionId: "fixture-session" });
    assert.equal(loaded.sourceHash, result.sourceHash);
    assert.equal(loaded.manifest.status, "complete");
    assert.equal(loaded.rawPath, join(result.snapshot, "source", "raw.jsonl"));
  });

  it("does not duplicate an unchanged source snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-session-"));
    const store = join(root, "store");
    const source = join(root, "session.jsonl");
    await writeFile(source, sessionText());
    await ingestSessionFile(source, store);

    const repeated = await ingestSessionFile(source, store);
    assert.equal(repeated.status, "unchanged");
    assert.equal(repeated.manifestStatus, "complete");
    assert.equal(repeated.change.class, "unchanged");
    assert.equal((await readdir(join(sessionDirectory(store), "snapshots"))).length, 1);
  });

  it("detects an append and keeps the previous snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-session-"));
    const store = join(root, "store");
    const source = join(root, "session.jsonl");
    await writeFile(source, sessionText());
    const first = await ingestSessionFile(source, store);

    const appended = sessionText([{ type: "session_info", id: "i1", parentId: null, timestamp: "2026-08-04T00:00:05.000Z", info: "wrapped" }]);
    await writeFile(source, appended);
    const second = await ingestSessionFile(source, store);

    assert.equal(second.status, "ingested");
    assert.equal(second.change.class, "append");
    assert.equal(second.change.previousSnapshot, first.sourceHash);
    assert.notEqual(second.sourceHash, first.sourceHash);
    assert.equal((await readdir(join(sessionDirectory(store), "snapshots"))).length, 2);
    const latest = JSON.parse(await readFile(join(sessionDirectory(store), "latest.json"), "utf8"));
    assert.equal(latest.sourceHash, second.sourceHash);
    const loaded = await readSessionSnapshot({ store, sessionId: "fixture-session" });
    assert.equal(loaded.sourceHash, second.sourceHash);
    assert.equal(await readFile(loaded.rawPath, "utf8"), appended);
    const previous = await readSessionSnapshot({ store, sessionId: "fixture-session", sourceHash: first.sourceHash });
    assert.equal((previous.manifest.change as { class: string }).class, "initial");
    assert.equal(await readFile(previous.rawPath, "utf8"), sessionText());
  });

  it("detects a replacement when an earlier line changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-session-"));
    const store = join(root, "store");
    const source = join(root, "session.jsonl");
    await writeFile(source, sessionText());
    const first = await ingestSessionFile(source, store);

    const edited = sessionText().replace('"hello"', '"hello again"');
    await writeFile(source, edited);
    const second = await ingestSessionFile(source, store);

    assert.equal(second.status, "ingested");
    assert.equal(second.change.class, "replacement");
    assert.equal(second.change.previousSnapshot, first.sourceHash);
    assert.equal(JSON.parse(await readFile(join(second.snapshot, "manifest.json"), "utf8")).change.class, "replacement");
  });

  it("detects truncation when trailing lines disappear", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-session-"));
    const store = join(root, "store");
    const source = join(root, "session.jsonl");
    await writeFile(source, sessionText());
    const first = await ingestSessionFile(source, store);

    const truncated = [header, modelChange, userMessage].map(line).join("");
    await writeFile(source, truncated);
    const second = await ingestSessionFile(source, store);

    assert.equal(second.status, "ingested");
    assert.equal(second.change.class, "truncation");
    assert.equal(second.change.previousSnapshot, first.sourceHash);
  });

  it("keeps a partial manifest with line diagnostics for malformed lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-session-"));
    const store = join(root, "store");
    const source = join(root, "session.jsonl");
    const lines = sessionText().split(/\r?\n/).filter(Boolean);
    lines.splice(3, 0, "{not json");
    const text = `${lines.join("\n")}\n`;
    await writeFile(source, text);

    const result = await ingestSessionFile(source, store);
    assert.equal(result.status, "ingested");
    assert.equal(result.manifestStatus, "partial");
    assert.equal(result.diagnostics, 1);
    assert.equal(await readFile(join(result.snapshot, "source", "raw.jsonl"), "utf8"), text);
    const manifest = JSON.parse(await readFile(join(result.snapshot, "manifest.json"), "utf8"));
    assert.equal(manifest.status, "partial");
    assert.equal(manifest.diagnostics[0].line, 4);
    assert.match(manifest.diagnostics[0].message, /invalid JSON/);
    assert.equal(manifest.counts.entries, 5);
  });

  it("rejects a file without a session header and writes nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-session-"));
    const store = join(root, "store");
    const source = join(root, "session.jsonl");
    await writeFile(source, line(modelChange) + line(userMessage));

    await assert.rejects(ingestSessionFile(source, store), /no valid Pi session header/);
    await assert.rejects(readFile(join(store, "store.json"), "utf8"));
  });

  it("rejects a header without an id", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-session-"));
    const store = join(root, "store");
    const source = join(root, "session.jsonl");
    await writeFile(source, line({ type: "session", version: 3, timestamp: "2026-08-04T00:00:00.000Z" }) + line(userMessage));

    await assert.rejects(ingestSessionFile(source, store), /has no id/);
  });
});
