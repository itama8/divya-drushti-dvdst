import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildProbeBundle } from "../src/probe/build-bundle.js";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe("CP0 probe", () => {
  it("extracts files, commands, and conservative skill attribution", async () => {
    const bundle = await buildProbeBundle({
      sessionPath: fixture("skill-session.jsonl"),
      devlogPath: fixture("skill-devlog.md"),
    });

    const counts = bundle.counts as Record<string, number>;
    assert.equal(counts.skillInvocations, 1);
    assert.equal(counts.commands, 1);
    assert.ok((counts.skillAttributedRecords ?? 0) > 0);

    const skills = bundle.skills as unknown as {
      invocations: Array<Record<string, unknown>>;
      attributedRecords: Array<Record<string, unknown> & { labels: Array<Record<string, unknown>> }>;
    };
    assert.equal(skills.invocations[0]?.name, "doc-check");
    assert.equal(skills.invocations[0]?.mode, "model-load-candidate");
    assert.ok(skills.attributedRecords.some((item) => item.recordId === "edit-doc" && item.labels.some((label) => label.basis === "within-turn-window")));
    assert.ok(skills.attributedRecords.some((item) => item.recordId === "a3" && item.labels.some((label) => label.basis === "within-turn-window")));
    assert.ok(!skills.attributedRecords.some((item) => item.recordId === "a1" && item.labels.some((label) => label.basis === "within-turn-window")));

    const comparison = bundle.devlogComparison as {
      contractsTouched: { matched: string[] };
      commits: { matched: string[] };
    };
    assert.deepEqual(comparison.contractsTouched.matched, ["src/a.ts"]);
    assert.deepEqual(comparison.commits.matched, ["abcdef1234567890abcdef1234567890abcdef12"]);
  });
});
