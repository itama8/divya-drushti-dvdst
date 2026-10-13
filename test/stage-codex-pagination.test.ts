import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { collectStageFromFile, collectStageFromSession, stageChanges } from "../src/stage/stage.js";

const patch = (before: string, after: string) => `*** Begin Patch\n*** Update File: file.txt\n@@\n-${before}\n+${after}\n*** End Patch`;
const call = (id: string, input: string) => ({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: id, input } });
const result = (id: string, parts: string[], success = true) => ({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: [
  { type: "input_text", text: success ? "Script completed\nWall time 0.1 seconds\nOutput:\n" : "Script failed\nOutput:\n" },
  ...parts.map(text => ({ type: "input_text", text })),
] } });
const wrapped = (input: string) => `text(await tools.apply_patch(${JSON.stringify(input)}));`;
const session = (cwd: string) => ({ type: "session_meta", payload: { id: "paginated-1", cwd, history_mode: "paginated" } });
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row) + "\n").join("");
function git(root: string, ...args: string[]) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function fixture(run: (root: string, first: string, next: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "dvdst-pagination-"));
  try {
    git(root, "init", "-q"); git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@test");
    await writeFile(join(root, "file.txt"), "base\n"); git(root, "add", "file.txt"); git(root, "commit", "-qm", "base");
    const first = join(root, "rollout-root-paginated-1.jsonl"), next = join(root, "rollout-next-paginated-1_window.jsonl");
    const prefix = [session(root), call("first", wrapped(patch("base", "first"))), result("first", ["{}"])].map((row, ordinal) => ({ ...row, ordinal }));
    const text = jsonl(prefix);
    // A predecessor can have an obsolete tail after the continuation boundary.
    await writeFile(first, text + jsonl([{ type: "event_msg", ordinal: 3, payload: { type: "old_tail" } }]));
    const second = [{ ...session(root), payload: { ...session(root).payload, history_base: { thread_id: "paginated-1", end_ordinal_exclusive: 3, end_byte_offset: Buffer.byteLength(text) } } },
      call("second", wrapped(patch("first", "second"))), result("second", ["{}"])].map((row, index) => ({ ...row, ordinal: 3 + index }));
    await writeFile(next, jsonl(second));
    await run(root, first, next);
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe("verified Codex pagination and literal batches", () => {
  it("the CLI lists both segments through the same verified loader", async () => fixture(async (root, first) => {
    const cli = new URL("../src/cli/session-stage.ts", import.meta.url).pathname;
    const result = spawnSync(process.execPath, ["--import", "tsx", cli, "--agent", "codex", "--session-file", first, "--list"], { encoding: "utf8", cwd: process.cwd() });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n").map(line => JSON.parse(line).resultEventId), ["codex:result:first", "codex:result:second"]);
    const manifest = join(root, "manifest.json");
    await writeFile(manifest, JSON.stringify({ schemaVersion: 1, head: git(root, "rev-parse", "HEAD"), sources: [{ kind: "session-file", path: first, sessionId: "paginated-1" }], mutations: [{ sessionId: "paginated-1", resultEventId: "codex:result:first" }, { sessionId: "paginated-1", resultEventId: "codex:result:second" }] }));
    assert.deepEqual((await stageChanges({ manifest, session: "caller", cwd: root })).conflicts, []);
    assert.equal(git(root, "show", ":file.txt"), "second");
  }));

  it("loads the same complete chain from root or continuation and stages exact dependent edits", async () => fixture(async (root, first, next) => {
    const a = await collectStageFromFile(first), b = await collectStageFromFile(next);
    assert.deepEqual(a, b);
    assert.deepEqual(a.patches.map(patch => patch.resultEventId), ["codex:result:first", "codex:result:second"]);
    const before = await readFile(join(root, ".git/index"));
    assert.deepEqual((await stageChanges({ sessionFile: next, cwd: root, dryRun: true })).conflicts, []);
    assert.deepEqual(await readFile(join(root, ".git/index")), before);
    assert.deepEqual((await stageChanges({ sessionFile: first, cwd: root })).conflicts, []);
    assert.equal(git(root, "show", ":file.txt"), "second");
    assert.equal(await readFile(join(root, "file.txt"), "utf8"), "base\n");
  }));

  it("preserves foreign staged bytes even with valid continuation evidence", async () => fixture(async (root, first) => {
    await writeFile(join(root, "foreign.txt"), "foreign\n"); git(root, "add", "foreign.txt");
    const before = await readFile(join(root, ".git/index"));
    assert.match((await stageChanges({ sessionFile: first, cwd: root })).conflicts[0]!.reason, /unrelated/);
    assert.deepEqual(await readFile(join(root, ".git/index")), before);
  }));

  it("refuses cross-thread inheritance, invalid byte boundaries, gaps, and duplicate segments", async () => fixture(async (root, first, next) => {
    const original = await readFile(next, "utf8");
    const rows = original.trim().split("\n").map(line => JSON.parse(line));
    for (const mutate of [
      (data: typeof rows) => { data[0].payload.history_base.thread_id = "foreign-session"; },
      (data: typeof rows) => { data[0].payload.history_base.end_byte_offset++; },
      (data: typeof rows) => { data[1].ordinal++; },
    ]) {
      const data = structuredClone(rows); mutate(data); await writeFile(next, jsonl(data));
      await assert.rejects(collectStageFromFile(first), /pagination/);
    }
    await writeFile(next, original);
    await writeFile(join(root, "rollout-duplicate-paginated-1_window.jsonl"), original);
    await assert.rejects(collectStageFromFile(first), /pagination/);
  }));

  it("refuses a continuation whose root is missing", async () => fixture(async (_root, first, next) => {
    await rm(first);
    await assert.rejects(collectStageFromFile(next), /missing.*root/);
  }));

  it("never substitutes sibling evidence for an explicit file with an identical header", async () => fixture(async (root, first) => {
    const explicit = join(root, "explicit.jsonl");
    await writeFile(explicit, await readFile(first, "utf8"));
    await assert.rejects(collectStageFromFile(explicit), /pagination/);
  }));

  it("pairs each literal patch with its own output slot and preserves shell warnings", () => {
    const input = `text(await tools.exec_command({cmd:"echo before",max_output_tokens:10}));\n${wrapped(patch("base", "first"))}\n${wrapped(patch("first", "second"))}\ntext(await tools.write_stdin({session_id:42,chars:""}));`;
    const rows = [session("/repo"), call("batch", input), result("batch", [JSON.stringify({ output: "{}" }), "{}", "{}", JSON.stringify({ output: "done" })])];
    const collected = collectStageFromSession(jsonl(rows));
    assert.deepEqual(collected.patches.map(patch => patch.resultEventId), ["codex:result:batch:patch:0", "codex:result:batch:patch:1"]);
    assert.equal(collected.bash[0]!.command, "echo before");
    const incomplete = [session("/repo"), call("batch", input), result("batch", ["{}"])];
    assert.throws(() => collectStageFromSession(jsonl(incomplete)), /output count/);
    assert.throws(() => collectStageFromSession(jsonl([session("/repo"), call("batch", input), result("batch", ["{}", "failed", "{}", "{}"]) ])), /not confirmed/);
  });

  it("does not attribute a patch after catches, arbitrary expressions, interpolation, or incomplete execution", () => {
    for (const input of [
      `try { ${wrapped(patch("base", "first"))} } catch {}`,
      `text(await tools.apply_patch(makePatch()));`,
      `text(await tools.apply_patch(\`\${patch}\`));`,
      `tools.apply_patch = fake; ${wrapped(patch("base", "first"))}`,
    ]) {
      const collected = collectStageFromSession(jsonl([session("/repo"), call("unsafe", input), result("unsafe", ["{}"]) ]));
      assert.equal(collected.patches.length, 0); assert.equal(collected.bash.length, 1);
    }
    assert.equal(collectStageFromSession(jsonl([session("/repo"), call("failed", wrapped(patch("base", "first"))), result("failed", ["{}"], false)])).patches.length, 0);
  });

  it("allows fixed read-only metadata/image companions without allowing rebinding or arbitrary computations", () => {
    const metadata = 'text(ALL_TOOLS.filter(x=>/stage|dvdst/.test(x.name+" "+x.description)).map(x=>({name:x.name,description:x.description.slice(0,180)})));';
    const image = 'const r=await tools.view_image({path:"/tmp/proof.png"});image(r.image_url);';
    const input = metadata + image + wrapped(patch("base", "first"));
    const output = result("mixed", ["[]", "", "{}"]);
    output.payload.output[2] = { type: "input_image", text: "" };
    assert.equal(collectStageFromSession(jsonl([session("/repo"), call("mixed", input), output])).patches.length, 1);
    for (const unsafe of [metadata.replace('x.name+" "+x.description', 'evil()'), image.replace('const r=', 'const tools='), image.replace('image(r.image_url);', 'tools.apply_patch=fake;')]) {
      assert.equal(collectStageFromSession(jsonl([session("/repo"), call("unsafe", unsafe + wrapped(patch("base", "first"))), result("unsafe", ["{}"])] )).patches.length, 0);
    }
  });
});
