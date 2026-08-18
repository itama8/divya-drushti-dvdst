import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ingestLiveEvidence } from "../src/store/ingest-live.js";
import { readLiveSnapshot } from "../src/store/read-live.js";

const input = `${JSON.stringify({ schemaVersion: 1, source: "pi.extension", sessionId: "fixture", sequence: 0, observedAt: "2026-03-13T10:00:00.000Z", type: "session.started", data: {} })}\n`;

describe("live ingestion store", () => {
  it("preserves source and normalized evidence in a content-addressed snapshot", async () => {
    const store = await mkdtemp(join(tmpdir(), "dvdst-store-"));
    const result = await ingestLiveEvidence(input, undefined, store);
    assert.equal(result.status, "ingested");
    const manifest = JSON.parse(await readFile(join(result.snapshot, "manifest.json"), "utf8"));
    assert.equal(manifest.source.sha256, result.sourceHash);
    assert.equal(await readFile(join(result.snapshot, "source", "events.jsonl"), "utf8"), input);
    const timeline = await readFile(join(result.snapshot, "records", "timeline.jsonl"), "utf8");
    assert.match(timeline, /"kind":"session.started"/);
    assert.equal(JSON.parse(await readFile(join(store, "store.json"), "utf8")).schemaVersion, 1);
    const loaded = await readLiveSnapshot({ store, source: "pi.extension", sessionId: "fixture" });
    assert.equal(loaded.sourceHash, result.sourceHash);
    assert.equal(loaded.records[0]?.id, "live:pi.extension:fixture:0");
  });

  it("does not duplicate an unchanged source snapshot", async () => {
    const store = await mkdtemp(join(tmpdir(), "dvdst-store-"));
    await ingestLiveEvidence(input, undefined, store);
    const repeated = await ingestLiveEvidence(input, undefined, store);
    assert.equal(repeated.status, "unchanged");
  });
});
