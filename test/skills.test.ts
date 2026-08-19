import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { normalizeSnapshot } from "../src/normalize/normalize.js";
import { extractSkills } from "../src/skills/extract.js";
import { ingestSessionFile } from "../src/store/ingest-session.js";

const header = { type: "session", version: 3, id: "skills-session", timestamp: "2026-08-04T00:00:00.000Z", cwd: "/tmp/example" };

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function message(id: string, parentId: string | null, role: string, content: unknown, extra: Record<string, unknown> = {}): unknown {
  return { type: "message", id, parentId, timestamp: "2026-08-04T00:00:00.000Z", message: { role, content, ...extra } };
}

function toolCall(id: string, name: string, args: unknown): unknown {
  return { type: "toolCall", id, name, arguments: args };
}

function text(value: string): unknown {
  return { type: "text", text: value };
}

const DOC_CHECK_BODY = "---\nname: doc-check\ndescription: Check documentation.\n---\n\n# Doc check\n\nEdit the documentation and run validation.";

async function prepare(root: string, entries: unknown[]): Promise<{ store: string; sessionId: string; snapshot: string }> {
  const store = join(root, "store");
  const source = join(root, "session.jsonl");
  await writeFile(source, entries.map(line).join(""));
  const ingested = await ingestSessionFile(source, store);
  await normalizeSnapshot({ store, sessionId: ingested.sessionId });
  const result = await extractSkills({ store, sessionId: ingested.sessionId });
  return { store, sessionId: ingested.sessionId, snapshot: result.snapshot };
}

async function rows<T>(path: string): Promise<T[]> {
  const text = await readFile(path, "utf8");
  return text.split("\n").filter((entry) => entry.trim().length > 0).map((entry) => JSON.parse(entry) as T);
}

function fixtureWith(includeExplicit = true, loadIsError = false): unknown[] {
  const userContent = includeExplicit
    ? [text(`<skill name="doc-check" location="/tmp/example/.pi/skills/doc-check/SKILL.md">\n${DOC_CHECK_BODY}\n</skill>\n\nApply the doc check.`)]
    : [text("Update the documentation and validate it.")];
  return [
    header,
    // turn 0: explicit skill command (when included) with an assistant turn after it
    message("u1", null, "user", userContent),
    message("a1", "u1", "assistant", [toolCall("read-skill", "read", { path: "/tmp/example/.pi/skills/doc-check/SKILL.md" })]),
    message("r1", "a1", "toolResult", [text(DOC_CHECK_BODY)], { toolCallId: "read-skill", toolName: "read", isError: loadIsError }),
    message("a2", "r1", "assistant", [toolCall("edit-doc", "edit", { path: "src/a.ts", edits: [] }), toolCall("run-test", "bash", { command: "npm test" })]),
    message("r2", "a2", "toolResult", [text("ok")], { toolCallId: "edit-doc", toolName: "edit", isError: false }),
    message("r3", "a2", "toolResult", [text("pass 30/30")], { toolCallId: "run-test", toolName: "bash", isError: false }),
    message("a3", "r3", "assistant", [text("Done.")]),
    // turn 1: a later user turn must not be attributed to the skill
    message("u2", "a3", "user", [text("Now update the README too.")]),
    message("a4", "u2", "assistant", [toolCall("read-readme", "read", { path: "README.md" })]),
    message("r4", "a4", "toolResult", [text("readme")], { toolCallId: "read-readme", toolName: "read", isError: false }),
  ];
}

const recordsDirectory = (snapshot: string): string => join(snapshot, "records");

describe("skill extraction from normalized records", () => {
  it("detects explicit commands and model-load candidates with distinct modes", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-skills-"));
    const { store, sessionId, snapshot } = await prepare(root, fixtureWith());
    const invocations = await rows<Record<string, unknown>>(join(recordsDirectory(snapshot), "skill-invocations.jsonl"));
    const explicit = invocations.filter((invocation) => invocation.mode === "explicit-command");
    const loadCandidates = invocations.filter((invocation) => invocation.mode === "model-load-candidate");
    assert.equal(invocations.length, 2);
    assert.equal(explicit[0]?.name, "doc-check");
    assert.equal(explicit[0]?.confidence, "observed");
    assert.equal(explicit[0]?.loadStatus, "expanded");
    assert.equal(typeof explicit[0]?.contentHash, "string");
    assert.equal(loadCandidates[0]?.name, "doc-check");
    assert.equal(loadCandidates[0]?.loadStatus, "loaded");
    assert.equal(loadCandidates[0]?.confidence, "reconstructed");
    // the call's content hash equals the read result body hash
    const result = await extractSkills({ store, sessionId });
    assert.equal(result.counts.explicitInvocations, 1);
    assert.equal(result.counts.modelLoadCandidates, 1);
  });

  it("keeps failed and unconfirmed skill loads visible but not active", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-skills-"));
    const failedFixture = fixtureWith(false, true);    const { snapshot } = await prepare(root, failedFixture);
    const invocations = await rows<Record<string, unknown>>(join(recordsDirectory(snapshot), "skill-invocations.jsonl"));
    const failed = invocations.filter((invocation) => invocation.loadStatus === "failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.mode, "model-load-candidate");
    assert.equal(failed[0]?.activeStartLine, null);
  });

  it("attributes records with a conservative same-turn rule and keeps overlaps", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-skills-"));
    const { snapshot } = await prepare(root, fixtureWith(true));
    const attributions = await rows<Record<string, unknown>>(join(recordsDirectory(snapshot), "skill-attributions.jsonl"));
    const runTest = attributions.find((attribution) => attribution.recordId === "run-test");
    assert.ok(runTest, "run-test tool call should be attributed");
    const labels = runTest?.labels as Array<{ invocationId: string; basis: string }>;
    // both the explicit command and the model load attribute the same turn, so
    // overlapping invocations keep separate labels instead of erasing each other
    assert.equal(labels.length, 2);
    assert.ok(labels.some((label) => label.basis === "within-turn-window"));
    // the later user turn and its tool call must not be attributed to the skill
    const readme = attributions.find((attribution) => attribution.recordId === "read-readme");
    assert.equal(readme, undefined);
    const u2 = attributions.find((attribution) => attribution.recordId === "u2");
    assert.equal(u2, undefined);
    const skillLoadLabel = attributions.find((attribution) => attribution.recordId === "read-skill");
    const skillLoadLabels = skillLoadLabel?.labels as Array<{ invocationId: string; basis: string }> | undefined;
    assert.ok(skillLoadLabels?.some((label) => label.basis === "skill-load"));
    assert.ok(skillLoadLabels?.some((label) => label.basis === "within-turn-window"));
  });

  it("is idempotent and deterministic", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-skills-"));
    const { store, sessionId, snapshot } = await prepare(root, fixtureWith(true));
    const names = ["skill-invocations.jsonl", "skill-attributions.jsonl"] as const;
    const before = await Promise.all(names.map((name) => readFile(join(recordsDirectory(snapshot), name), "utf8")));
    await extractSkills({ store, sessionId });
    const after = await Promise.all(names.map((name) => readFile(join(recordsDirectory(snapshot), name), "utf8")));
    assert.deepEqual(after, before);
  });

  it("emits spans with an explicit boundary rule", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-skills-"));
    const { snapshot } = await prepare(root, fixtureWith(true));
    const invocations = await rows<Record<string, unknown>>(join(recordsDirectory(snapshot), "skill-invocations.jsonl"));
    const explicit = invocations.find((invocation) => invocation.mode === "explicit-command");
    assert.ok(explicit && typeof explicit.activeStartLine === "number");
    assert.ok(typeof explicit.activeEndLine === "number");
    assert.equal(explicit.boundaryRule, "explicit-command");
    const load = invocations.find((invocation) => invocation.mode === "model-load-candidate");
    assert.equal(load?.boundaryRule, "same-agent-turn");
  });
});
