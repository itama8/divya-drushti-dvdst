import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { handoffToText, buildHandoffSummary } from "../src/handoff/summary.js";
import { buildProbeBundle } from "../src/probe/build-bundle.js";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe("handoff summary", () => {
  it("reports accepted status and matched files for the fixture", async () => {
    const bundle = await buildProbeBundle({ sessionPath: fixture("skill-session.jsonl"), devlogPath: fixture("skill-devlog.md") });
    const summary = buildHandoffSummary(bundle);

    assert.equal(summary.status, "accepted");
    assert.equal(summary.outcome, "stable");
    assert.equal(summary.tests.ran, true);
    assert.equal(summary.commands.tests, 1);
    assert.deepEqual(summary.files.modified, ["src/a.ts"]);
    assert.equal(summary.commits.matched.length, 1);
    assert.equal(summary.skills.explicitCommands + summary.skills.loadCandidates, 1);
  });

  it("renders readable text", async () => {
    const bundle = await buildProbeBundle({ sessionPath: fixture("skill-session.jsonl"), devlogPath: fixture("skill-devlog.md") });
    const text = handoffToText(buildHandoffSummary(bundle));
    assert.match(text, /Session: fixture-session/);
    assert.match(text, /Status: accepted/);
    assert.match(text, /Modified files \(1\)/);
    assert.match(text, /matched abcdef1234567890abcdef1234567890abcdef12/);
  });
});
