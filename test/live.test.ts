import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LiveDecomposer, LiveEventError, parseLiveEvent } from "../src/live/decompose.js";

const event = {
  schemaVersion: 1,
  source: "pi.extension",
  sessionId: "session-1",
  sequence: 0,
  observedAt: "2026-03-13T10:00:00.000Z",
  type: "tool.started",
  data: { toolCallId: "call-1", toolName: "bash", args: { command: "npm test" } },
};

describe("live decomposition", () => {
  it("preserves each source event as provenance-backed observed evidence", () => {
    const parsed = parseLiveEvent(JSON.stringify(event), 7);
    assert.ok(parsed);
    const record = new LiveDecomposer().ingest(parsed, 7);
    assert.deepEqual(record, {
      schemaVersion: 1,
      id: "live:pi.extension:session-1:0",
      kind: "tool.started",
      sessionId: "session-1",
      sequence: 0,
      observedAt: "2026-03-13T10:00:00.000Z",
      confidence: "observed",
      provenance: { adapter: "live", source: "pi.extension", eventId: "pi.extension:session-1:0", inputLine: 7 },
      data: event.data,
    });
  });

  it("rejects malformed events, duplicate IDs, and non-monotonic session order", () => {
    assert.throws(() => parseLiveEvent('{"schemaVersion":1}', 2), LiveEventError);
    const decomposer = new LiveDecomposer();
    const first = parseLiveEvent(JSON.stringify(event), 1);
    assert.ok(first);
    decomposer.ingest(first, 1);
    assert.throws(() => decomposer.ingest(first, 2), /duplicate eventId/);

    const regressing = parseLiveEvent(JSON.stringify({ ...event, eventId: "different", sequence: 0 }), 3);
    assert.ok(regressing);
    assert.throws(() => decomposer.ingest(regressing, 3), /must be greater/);
  });
});
