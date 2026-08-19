import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { extractArtifacts } from "../src/artifacts/extract.js";
import { extractEvents } from "../src/events/extract.js";
import { normalizeSnapshot } from "../src/normalize/normalize.js";
import { extractSkills } from "../src/skills/extract.js";
import { ingestSessionFile } from "../src/store/ingest-session.js";

const jqAvailable = spawnSync("jq", ["--version"], { stdio: "ignore" }).status === 0;

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function message(id: string, parentId: string | null, role: string, content: unknown, extra: Record<string, unknown> = {}): unknown {
  return { type: "message", id, parentId, timestamp: "2026-08-20T00:00:00.000Z", message: { role, content, ...extra } };
}

function toolCall(id: string, name: string, args: unknown): unknown {
  return { type: "toolCall", id, name, arguments: args };
}

function text(value: string): unknown {
  return { type: "text", text: value };
}

function session(id: string, skillBody: string): unknown[] {
  return [
    { type: "session", version: 3, id, timestamp: "2026-08-20T00:00:00.000Z", cwd: "/tmp/demo" },
    message("u1", null, "user", [text("Validate the change.")]),
    message("a1", "u1", "assistant", [toolCall("read-skill", "read", { path: "/tmp/demo/.pi/skills/version-check/SKILL.md" })]),
    message("r1", "a1", "toolResult", [text(skillBody)], { toolCallId: "read-skill", toolName: "read", isError: false }),
    message("a2", "r1", "assistant", [toolCall("run-test", "bash", { command: "npm test" })]),
    message("r2", "a2", "toolResult", [text("pass 10/10")], { toolCallId: "run-test", toolName: "bash", isError: false }),
    message("a3", "r2", "assistant", [toolCall("typecheck", "bash", { command: "npm run typecheck" })]),
    message("r3", "a3", "toolResult", [text("tsc: error")], { toolCallId: "typecheck", toolName: "bash", isError: true }),
  ];
}

async function rows<T>(path: string): Promise<T[]> {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(path, "utf8");
  return text.split("\n").filter((entry) => entry.trim().length > 0).map((entry) => JSON.parse(entry) as T);
}

describe("cookbook recipes", { skip: !jqAvailable }, () => {
  it("reproduces the documented skill-version and attributed-command recipes", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-cookbook-"));
    const store = join(root, "store");
    const ids = ["cookbook-v1", "cookbook-v2"];
    const bodies = {
      "cookbook-v1": "---\nname: version-check\n---\n\n# Version check v1\n\nRun the tests.",
      "cookbook-v2": "---\nname: version-check\n---\n\n# Version check v2\n\nRun the tests.",
    };
    for (const id of ids) {
      const source = join(root, `${id}.jsonl`);
      await writeFile(source, session(id, bodies[id as keyof typeof bodies]).map(line).join(""));
      const ingested = await ingestSessionFile(source, store);
      await normalizeSnapshot({ store, sessionId: ingested.sessionId });
      await extractArtifacts({ store, sessionId: ingested.sessionId });
      await extractSkills({ store, sessionId: ingested.sessionId });
      await extractEvents({ store, sessionId: ingested.sessionId });
    }

    const latestHash = (sessionId: string): string => {
      return JSON.parse(readFileSync(join(store, "sessions", "pi", sessionId, "latest.json"), "utf8")).sourceHash as string;
    };
    const base = (sessionId: string): string => join(store, "sessions", "pi", sessionId, "snapshots", latestHash(sessionId));

    // Recipe: skill versions by content hash, one line per invocation.
    const invocations = await rows<Record<string, unknown>>(join(base("cookbook-v1"), "records", "skill-invocations.jsonl"));
    assert.equal(invocations.length, 1);
    assert.notEqual(invocations[0]?.contentHash, undefined);
    const v2 = await rows<Record<string, unknown>>(join(base("cookbook-v2"), "records", "skill-invocations.jsonl"));
    assert.notEqual(v2[0]?.contentHash, invocations[0]?.contentHash, "different skill bodies must hash differently");

    // Recipe: attributed command activity per skill (the jq join from the cookbook).
    const joinRecipe = `
      ($attrs[] | select(.recordKind == "tool-call")) as $attr
      | ($cmds[] | select(.toolCallId == $attr.recordId)) as $cmd
      | {toolCallId: $cmd.toolCallId, command: $cmd.command,
         isError: (if $cmd.result then $cmd.result.isError else null end),
         skills: [$attr.labels[].invocationId]}`;
    const result = spawnSync("jq", [
      "-nc",
      "--slurpfile", "attrs", join(base("cookbook-v2"), "records", "skill-attributions.jsonl"),
      "--slurpfile", "cmds", join(base("cookbook-v2"), "artifacts", "commands.jsonl"),
      joinRecipe,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split("\n").map((entry) => JSON.parse(entry) as { toolCallId: string; command: string; isError: boolean });
    assert.equal(lines.length, 2, "the join must attribute both commands to the skill");
    assert.deepEqual(lines.map((entry) => entry.toolCallId).sort(), ["run-test", "typecheck"]);
    assert.deepEqual(lines.map((entry) => entry.isError), [false, true]);
  });
});
