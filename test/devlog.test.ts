import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { devlogFromSummary } from "../src/devlog/format-devlog.js";
import { buildHandoffSummary } from "../src/handoff/summary.js";
import { buildProbeBundle } from "../src/probe/build-bundle.js";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe("handoff-to-devlog mapper", () => {
  it("emits a valid frontmatter and evidence body", async () => {
    const bundle = await buildProbeBundle({ sessionPath: fixture("skill-session.jsonl"), devlogPath: fixture("skill-devlog.md") });
    const summary = buildHandoffSummary(bundle);
    const devlog = devlogFromSummary(summary, {
      date: "2026-08-04",
      session: 99,
      project: "omakase-v2",
      phase: "docs-spine",
      checkpoint: "smoke-test",
      focus: "Smoke test the auto handoff",
    });
    const block = devlog.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    assert.match(block, /^status: accepted/m);
    assert.match(block, /^commit_match_confidence: 1(\.0+)?$/m);
    assert.match(block, /- src\/a\.ts/);
    assert.match(devlog, /Skills observed: doc-check/);
  });
});
