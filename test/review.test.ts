import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LiveReviewReducer } from "../src/live/review.js";
import type { LiveEvent } from "../src/live/decompose.js";

function event(sequence: number, type: string, data: unknown): LiveEvent {
  return {
    schemaVersion: 1,
    source: "pi.extension",
    sessionId: "review-fixture",
    sequence,
    observedAt: `2026-03-13T10:00:0${sequence}.000Z`,
    type,
    data,
  };
}

describe("live review reduction", () => {
  it("emits one review handoff after a settled agent with a completed mutation and later test", () => {
    const reducer = new LiveReviewReducer();
    assert.equal(reducer.ingest(event(0, "tool.started", {
      toolCallId: "edit-1", toolName: "edit", args: { path: "src/review.ts", edits: [] },
    })), undefined);
    assert.equal(reducer.ingest(event(1, "tool.finished", { toolCallId: "edit-1", isError: false })), undefined);
    assert.equal(reducer.ingest(event(2, "tool.started", {
      toolCallId: "test-1", toolName: "bash", args: { command: "npm test" },
    })), undefined);
    assert.equal(reducer.ingest(event(3, "tool.finished", { toolCallId: "test-1", isError: false })), undefined);

    const ready = reducer.ingest(event(4, "agent.settled", {}));
    assert.deepEqual(ready, {
      schemaVersion: 1,
      kind: "review-ready",
      confidence: "inferred",
      sessionId: "review-fixture",
      settledAt: "2026-03-13T10:00:04.000Z",
      mutations: [{
        path: "src/review.ts",
        operation: "edit",
        toolCallId: "edit-1",
        sourceEventId: "pi.extension:review-fixture:0",
        resultEventId: "pi.extension:review-fixture:1",
      }],
      validation: { testsAfterFinalMutation: "passed", commandsFailed: [] },
      evidence: ["pi.extension:review-fixture:1"],
      limit: "This frame lists completed tool operations from the observed stream. It does not prove the repository diff, isolate concurrent writers, or provide a semantic code review.",
    });
    assert.equal(reducer.ingest(event(5, "agent.settled", {})), undefined);
  });

  it("does not treat failed writes or earlier tests as validated mutations", () => {
    const reducer = new LiveReviewReducer();
    reducer.ingest(event(0, "tool.started", {
      toolCallId: "test-1", toolName: "bash", args: { command: "npm test" },
    }));
    reducer.ingest(event(1, "tool.finished", { toolCallId: "test-1", isError: false }));
    reducer.ingest(event(2, "tool.started", {
      toolCallId: "write-1", toolName: "write", args: { path: "src/new.ts", content: "export {};" },
    }));
    reducer.ingest(event(3, "tool.finished", { toolCallId: "write-1", isError: false }));
    reducer.ingest(event(4, "tool.started", {
      toolCallId: "lint-1", toolName: "bash", args: { command: "npm run lint" },
    }));
    reducer.ingest(event(5, "tool.finished", { toolCallId: "lint-1", isError: true }));

    const ready = reducer.ingest(event(6, "agent.settled", {}));
    assert.equal(ready?.validation.testsAfterFinalMutation, "not-observed");
    assert.deepEqual(ready?.validation.commandsFailed, [{
      command: "npm run lint", toolCallId: "lint-1", sourceEventId: "pi.extension:review-fixture:5",
    }]);

    reducer.ingest(event(7, "tool.started", {
      toolCallId: "write-2", toolName: "write", args: { path: "src/failed.ts", content: "" },
    }));
    reducer.ingest(event(8, "tool.finished", { toolCallId: "write-2", isError: true }));
    assert.equal(reducer.ingest(event(9, "agent.settled", {})), undefined);
  });
});
