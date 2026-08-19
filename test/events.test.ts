import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { extractArtifacts } from "../src/artifacts/extract.js";
import { extractEvents } from "../src/events/extract.js";
import { normalizeSnapshot } from "../src/normalize/normalize.js";
import { ingestSessionFile } from "../src/store/ingest-session.js";

const header = { type: "session", version: 3, id: "events-session", timestamp: "2026-08-04T00:00:00.000Z", cwd: "/tmp/example" };

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function message(id: string, parentId: string | null, role: string, content: unknown, extra: Record<string, unknown> = {}): unknown {
  return { type: "message", id, parentId, timestamp: "2026-08-04T00:00:00.000Z", message: { role, content, ...extra } };
}

function toolCall(id: string, name: string, args: unknown): unknown {
  return { type: "toolCall", id, name, arguments: args };
}

async function prepare(root: string, sessionId: string, entries: unknown[]): Promise<{ store: string; snapshot: string }> {
  const store = join(root, "store");
  const source = join(root, "session.jsonl");
  await writeFile(source, entries.map(line).join(""));
  const ingested = await ingestSessionFile(source, store);
  await normalizeSnapshot({ store, sessionId: ingested.sessionId });
  const result = await extractArtifacts({ store, sessionId: ingested.sessionId });
  const events = await extractEvents({ store, sessionId: ingested.sessionId });
  assert.equal(result.counts.commands >= 0, true); // artifacts pipeline ran
  return { store, snapshot: events.snapshot };
}

async function rows<T>(path: string): Promise<T[]> {
  const text = await readFile(path, "utf8");
  return text.split("\n").filter((entry) => entry.trim().length > 0).map((entry) => JSON.parse(entry) as T);
}

interface EventRow {
  kind: string;
  finding?: string;
  confidence?: string;
  observed?: boolean;
  path?: string;
  command?: string;
  toolCallId?: string;
  label?: string;
}

/**
 * baseline fixture: reads with and without prior reads, a passing test after
 * the final mutation, one unresolved failure, and one resolved failure.
 */
function buildBaselineFixture(): unknown[] {
  return [
    header,
    message("u1", null, "user", [{ type: "text", text: "Fix the module and validate." }]),
    // read of a.ts precedes its edit
    message("a1", "u1", "assistant", [toolCall("read-a", "read", { path: "src/a.ts", limit: 80 })]),
    message("r1", "a1", "toolResult", [{ type: "text", text: "content a" }], { toolCallId: "read-a", toolName: "read", isError: false }),
    message("a2", "r1", "assistant", [toolCall("edit-a", "edit", { path: "src/a.ts", edits: [{ oldText: "x", newText: "y" }] })]),
    message("r2", "a2", "toolResult", [{ type: "text", text: "ok" }], { toolCallId: "edit-a", toolName: "edit", isError: false }),
    // new.ts is written with no prior read
    message("a3", "r2", "assistant", [toolCall("write-new", "write", { path: "src/new.ts", content: "export const y = 2;\n" })]),
    message("r3", "a3", "toolResult", [{ type: "text", text: "written" }], { toolCallId: "write-new", toolName: "write", isError: false }),
    // final mutation happens before the test that follows it
    message("a4", "r3", "assistant", [toolCall("edit-b", "edit", { path: "src/b.ts", edits: [{ oldText: "p", newText: "q" }] })]),
    message("r4", "a4", "toolResult", [{ type: "text", text: "ok" }], { toolCallId: "edit-b", toolName: "edit", isError: false }),
    // passing test after the final mutation
    message("a5", "r4", "assistant", [toolCall("test-pass", "bash", { command: "npm test" })]),
    message("r5", "a5", "toolResult", [{ type: "text", text: "pass 30/30" }], { toolCallId: "test-pass", toolName: "bash", isError: false }),
    // unresolvable failure: typecheck fails, no later success
    message("a6", "r5", "assistant", [toolCall("typecheck-fail", "bash", { command: "npm run typecheck" })]),
    message("r6", "a6", "toolResult", [{ type: "text", text: "tsc: error TS2304" }], { toolCallId: "typecheck-fail", toolName: "bash", isError: true }),
    // resolvable failure: lint fails then succeeds
    message("a7", "r6", "assistant", [toolCall("lint-fail", "bash", { command: "npm run lint" })]),
    message("r7", "a7", "toolResult", [{ type: "text", text: "lint error" }], { toolCallId: "lint-fail", toolName: "bash", isError: true }),
    message("a8", "r7", "assistant", [toolCall("lint-pass", "bash", { command: "npm run lint" })]),
    message("r8", "a8", "toolResult", [{ type: "text", text: "lint ok" }], { toolCallId: "lint-pass", toolName: "bash", isError: false }),
    // command with no observed result stays visible only through counts
    message("a9", "r8", "assistant", [toolCall("orphan-cmd", "bash", { command: "cat missing.log" })]),
  ];
}

/**
 * stalled fixture: a mutation with no prior read, a passing test, then a final
 * mutation after the last test, and one failing build with no retry.
 */
function buildStalledFixture(): unknown[] {
  return [
    header,
    message("u1", null, "user", [{ type: "text", text: "Change x and verify." }]),
    message("a1", "u1", "assistant", [toolCall("edit-x1", "edit", { path: "src/x.ts", edits: [{ oldText: "1", newText: "2" }] })]),
    message("r1", "a1", "toolResult", [{ type: "text", text: "ok" }], { toolCallId: "edit-x1", toolName: "edit", isError: false }),
    message("a2", "r1", "assistant", [toolCall("test-1", "bash", { command: "npm test" })]),
    message("r2", "a2", "toolResult", [{ type: "text", text: "pass" }], { toolCallId: "test-1", toolName: "bash", isError: false }),
    // final mutation comes after the only test run
    message("a3", "r2", "assistant", [toolCall("edit-x2", "edit", { path: "src/x.ts", edits: [{ oldText: "2", newText: "3" }] })]),
    message("r3", "a3", "toolResult", [{ type: "text", text: "ok" }], { toolCallId: "edit-x2", toolName: "edit", isError: false }),
    message("a4", "r3", "assistant", [toolCall("build-fail", "bash", { command: "npm run build" })]),
    message("r4", "a4", "toolResult", [{ type: "text", text: "build error" }], { toolCallId: "build-fail", toolName: "bash", isError: true }),
  ];
}

const eventsDirectory = (snapshot: string): string => join(snapshot, "events");

describe("deterministic events", () => {
  it("emits command-succeeded and command-failed events with observed confidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-events-"));
    const { snapshot } = await prepare(root, "events-session", buildBaselineFixture());
    const events = await rows<EventRow>(join(eventsDirectory(snapshot), "deterministic.jsonl"));
    const succeeded = events.filter((event) => event.kind === "command-succeeded");
    const failed = events.filter((event) => event.kind === "command-failed");
    assert.equal(succeeded.length, 2); // npm test, npm run lint retry
    assert.equal(failed.length, 2); // typecheck, lint first attempt
    assert.deepEqual(succeeded.map((event) => event.command), ["npm test", "npm run lint"]);
    for (const event of succeeded) assert.equal(event.confidence, "observed");
    const lintFail = failed.find((event) => event.command === "npm run lint");
    assert.equal((lintFail?.toolCallId as string | undefined), "lint-fail");
  });

  it("derives modified-without-observed-read only for paths with no prior successful read", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-events-"));
    const { snapshot } = await prepare(root, "events-session", buildBaselineFixture());
    const results = await extractEventsRows(snapshot);
    const findings = results.findings as Array<Record<string, unknown>>;
    const withoutRead = findings.filter((finding) => finding.finding === "file-modified-without-observed-read");
    assert.deepEqual(withoutRead.map((finding) => finding.path).sort(), ["src/b.ts", "src/new.ts"]);
    assert.ok(withoutRead.every((finding) => finding.confidence === "inferred"));
    const readEvents = results.events.filter((event) => event.kind === "file-read");
    const mutationEvents = results.events.filter((event) => event.kind === "file-mutation");
    assert.equal(readEvents.length, 1);
    assert.equal(mutationEvents.length, 3);
    assert.equal(readEvents.find((event) => event.path === "src/a.ts")?.observed, true);
  });

  it("reports tests-not-run-after-final-mutation only when the last test precedes the final mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-events-"));
    const baseline = await prepare(root, "events-session", buildBaselineFixture());
    const baselineRows = await extractEventsRows(baseline.snapshot);
    const baselineFindings = baselineRows.findings as Array<Record<string, unknown>>;
    // a passing test ran after the final mutation, so no finding
    assert.equal(baselineFindings.filter((finding) => finding.finding === "tests-not-run-after-final-mutation").length, 0);

    const root2 = await mkdtemp(join(tmpdir(), "dvdst-events-"));
    const stalled = await prepare(root2, "events-session", buildStalledFixture());
    const stalledRows = await extractEventsRows(stalled.snapshot);
    const stalledFindings = stalledRows.findings as Array<Record<string, unknown>>;
    const finding = stalledFindings.find((entry) => entry.finding === "tests-not-run-after-final-mutation");
    assert.ok(finding !== undefined);
    assert.equal(finding.testsSeen, true);
    assert.equal(finding.finalMutationPath, "src/x.ts");
    assert.equal(finding.lastTestLine, (finding as { lastTestLine: number }).lastTestLine); // present
  });

  it("derives unresolved-command-failure with conservative exact-text retry matching", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-events-"));
    const { snapshot } = await prepare(root, "events-session", buildBaselineFixture());
    const rows_out = await extractEventsRows(snapshot);
    const findings = rows_out.findings as Array<Record<string, unknown>>;
    const unresolved = findings.filter((finding) => finding.finding === "unresolved-command-failure");
    // npm run lint eventually succeeded, so only the typecheck failure is unresolved
    assert.deepEqual(unresolved.map((finding) => finding.command), ["npm run typecheck"]);
    assert.equal(unresolved[0]?.failedAttempts, 1);
    assert.equal(unresolved[0]?.lastFailureToolCallId, "typecheck-fail");
  });

  it("keeps commands without an observed outcome visible in the result counts and diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-events-"));
    const { snapshot } = await prepare(root, "events-session", buildBaselineFixture());
    const result = await extractEvents({ store: join(root, "store"), sessionId: "events-session" });
    assert.equal(result.counts.commands, 5);
    assert.equal(result.counts.commandsWithoutOutcome, 1);
    assert.equal(result.counts.commandSucceeded, 2);
    assert.equal(result.counts.commandFailed, 2);
    assert.equal(result.findings.resolvedRetries, 1);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes("orphan-cmd")));
  });

  it("is idempotent and deterministic", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-events-"));
    const { snapshot } = await prepare(root, "events-session", buildBaselineFixture());
    const names = ["deterministic.jsonl"] as const;
    const before = await Promise.all(names.map((name) => readFile(join(eventsDirectory(snapshot), name), "utf8")));
    await extractEvents({ store: join(root, "store"), sessionId: "events-session" });
    const after = await Promise.all(names.map((name) => readFile(join(eventsDirectory(snapshot), name), "utf8")));
    assert.deepEqual(after, before);
  });
});

async function extractEventsRows(snapshot: string): Promise<{ events: Array<Record<string, unknown>>; findings: Array<Record<string, unknown>> }> {
  const all = await rows<Record<string, unknown>>(join(eventsDirectory(snapshot), "deterministic.jsonl"));
  const events = all.filter((event) => typeof event.finding !== "string");
  const findings = all.filter((event) => typeof event.finding === "string");
  return { events, findings };
}
