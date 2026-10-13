import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { stageChanges } from "../src/stage/stage.js";

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await run(f); } finally { await rm(f.scratch, { recursive: true, force: true }); }
}
async function setup() {
  const scratch = await mkdtemp(join(tmpdir(), "dvdst-manifest-"));
  const root = join(scratch, "repo");
  const elsewhere = join(scratch, "elsewhere");
  await mkdir(root); await mkdir(elsewhere);
  git(root, "init", "-q");
  await writeFile(join(root, "file.txt"), "base\nkeep\n");
  git(root, "add", ".");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@test", "commit", "-qm", "base");
  const edit = (path: string, oldText: string, newText: string) => ({ name: "edit", arguments: { path, edits: [{ oldText, newText }] } });
  async function source(id: string, cwd: string, calls: Array<{ name: string; arguments: unknown }>) {
    const path = join(scratch, `${id}.jsonl`);
    const entries = [
      { type: "session", id, cwd },
      ...calls.flatMap((c, i) => [
        { type: "message", id: `call-${i}`, message: { role: "assistant", content: [{ type: "toolCall", id: `tool-${i}`, ...c }] } },
        { type: "message", id: `result-${i}`, message: { role: "toolResult", toolCallId: `tool-${i}`, isError: false } },
      ]),
    ];
    await writeFile(path, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
    return { kind: "session-file", path, sessionId: id };
  }
  const first = await source("first", root, [
    edit("file.txt", "base", "middle"),
    edit("file.txt", "second", "final"),
    { name: "write", arguments: { path: "foreign.txt", content: "not selected\n" } },
    { name: "bash", arguments: { command: "sed -i s/a/b/ unowned.txt" } },
  ]);
  const second = await source("second", elsewhere, [
    edit(join(root, "file.txt"), "middle", "second"),
    { name: "write", arguments: { path: join(root, "new.txt"), content: "new\n" } },
  ]);
  const third = await source("third", root, [edit("new.txt", "new", "finished")]);
  const manifest = join(scratch, "selection.json");
  const data = {
    schemaVersion: 1, head: git(root, "rev-parse", "HEAD").trim(), sources: [first, second, third],
    mutations: [
      { sessionId: "first", resultEventId: "result-0" },
      { sessionId: "second", resultEventId: "result-0" },
      { sessionId: "first", resultEventId: "result-1" },
      { sessionId: "second", resultEventId: "result-1" },
      { sessionId: "third", resultEventId: "result-0" },
    ],
  };
  const save = () => writeFile(manifest, JSON.stringify(data));
  await save();
  return { scratch, root, elsewhere, manifest, data, save, source, edit, options: { manifest, cwd: root, session: "caller" } };
}

describe("explicit cross-session staging", () => {
  it("still rejects reused Pi result IDs instead of treating them as a multi-file Codex call", async () => fixture(async f => {
    const file = f.data.sources[0]!.path;
    await writeFile(file, (await readFile(file, "utf8")).replace('"id":"result-1"', '"id":"result-0"'));
    const before = await readFile(join(f.root, ".git/index"));
    await assert.rejects(stageChanges(f.options), /ambiguous/);
    assert.deepEqual(await readFile(join(f.root, ".git/index")), before);
  }));

  it("interleaves exact calls, preserves foreign dirty hunks, and repeats safely", async () => fixture(async f => {
    await writeFile(join(f.root, "file.txt"), "final\nforeign dirty\n");
    const before = await readFile(join(f.root, ".git/index"));
    const dry = await stageChanges({ ...f.options, dryRun: true });
    assert.deepEqual(dry.conflicts, []);
    assert.equal(dry.staged.length, 2);
    assert.deepEqual(await readFile(join(f.root, ".git/index")), before);
    const report = await stageChanges(f.options);
    assert.equal(report.source, "manifest");
    assert.equal(report.sessionId, "caller");
    assert.equal(report.selection?.mutations.length, 5);
    assert.equal(report.unattributedBashCount, 1);
    assert.equal(git(f.root, "show", ":file.txt"), "final\nkeep\n");
    assert.equal(git(f.root, "show", ":new.txt"), "finished\n");
    assert.equal(git(f.root, "ls-files", "foreign.txt"), "");
    assert.equal(await readFile(join(f.root, "file.txt"), "utf8"), "final\nforeign dirty\n");
    assert.deepEqual((await stageChanges(f.options)).unchanged, ["file.txt", "new.txt"]);
  }));

  it("blocks missing dependencies or wrong order without partial publication", async () => fixture(async f => {
    const before = await readFile(join(f.root, ".git/index"));
    [f.data.mutations[0], f.data.mutations[1]] = [f.data.mutations[1]!, f.data.mutations[0]!];
    await f.save();
    const report = await stageChanges(f.options);
    assert.match(report.conflicts[0]?.reason ?? "", /anchor/);
    assert.deepEqual(report.staged, []);
    assert.deepEqual(await readFile(join(f.root, ".git/index")), before);
  }));

  it("preserves foreign staged content on selected and unselected paths", async () => fixture(async f => {
    for (const path of ["file.txt", "other.txt"]) {
      await writeFile(join(f.root, path), "foreign staged\n");
      git(f.root, "add", path);
      const before = await readFile(join(f.root, ".git/index"));
      assert.ok((await stageChanges(f.options)).conflicts.length > 0);
      assert.deepEqual(await readFile(join(f.root, ".git/index")), before);
    }
  }));

  it("rejects stale HEAD, duplicate or unknown selectors, and identity mismatches", async () => fixture(async f => {
    const original = structuredClone(f.data);
    const before = await readFile(join(f.root, ".git/index"));
    const changes = [
      () => { f.data.head = "0".repeat(40); },
      () => { f.data.mutations.push(f.data.mutations[0]!); },
      () => { f.data.mutations[0]!.resultEventId = "missing"; },
      () => { f.data.mutations[0]!.sessionId = "missing"; },
      () => { f.data.sources[0]!.sessionId = "wrong"; },
      () => { f.data.sources.push(f.data.sources[0]!); },
      () => { f.data.mutations[0]!.resultEventId = "result-3"; }, // bash is not a selectable mutation
    ];
    for (const change of changes) {
      Object.assign(f.data, structuredClone(original)); change(); await f.save();
      await assert.rejects(stageChanges(f.options));
      assert.deepEqual(await readFile(join(f.root, ".git/index")), before);
    }
  }));

  it("rejects tracked writes, inherited forks, unused sources, and relative cwd", async () => fixture(async f => {
    const before = await readFile(join(f.root, ".git/index"));
    const tracked = await f.source("tracked", f.root, [{ name: "write", arguments: { path: "file.txt", content: "replacement" } }]);
    f.data.sources = [tracked]; f.data.mutations = [{ sessionId: "tracked", resultEventId: "result-0" }]; await f.save();
    assert.match((await stageChanges(f.options)).conflicts[0]?.reason ?? "", /pre-image/);
    await writeFile(tracked.path, JSON.stringify({ type: "session", id: "tracked", cwd: f.root, parentSession: "parent" }));
    await assert.rejects(stageChanges(f.options), /inherited/);
    await writeFile(tracked.path, JSON.stringify({ type: "session", id: "tracked", cwd: "." }));
    await assert.rejects(stageChanges(f.options), /absolute/);
    const unused = await f.source("unused", f.root, [f.edit("file.txt", "base", "unused")]);
    f.data.sources = [unused]; f.data.mutations = []; await f.save();
    await assert.rejects(stageChanges(f.options), /invalid/);
    assert.deepEqual(await readFile(join(f.root, ".git/index")), before);
  }));

  it("resolves manifest-relative source files and accepts validated live evidence", async () => fixture(async f => {
    const live = [
      { type: "session.started", data: { cwd: f.root } },
      { type: "tool.started", data: { toolCallId: "edit", toolName: "edit", args: { path: "new.txt", edits: [{ oldText: "new", newText: "finished" }] } } },
      { type: "tool.finished", data: { toolCallId: "edit", isError: false } },
    ].map((event, sequence) => ({ ...event, schemaVersion: 1, source: "pi.extension", sessionId: "third", sequence, eventId: `live-${sequence}`, observedAt: "2026-09-30T00:00:00Z" }));
    await writeFile(join(f.scratch, "live.jsonl"), live.map(event => JSON.stringify(event)).join("\n") + "\n");
    f.data.sources[2] = { kind: "live", path: "live.jsonl", sessionId: "third" };
    f.data.mutations[4]!.resultEventId = "live-2";
    await f.save();
    assert.deepEqual((await stageChanges(f.options)).conflicts, []);
    assert.equal(git(f.root, "show", ":new.txt"), "finished\n");
  }));

  it("rejects unused sources and unknown manifest fields", async () => fixture(async f => {
    const unused = await f.source("unused", f.root, [f.edit("file.txt", "base", "unused")]);
    f.data.sources.push(unused); await f.save();
    await assert.rejects(stageChanges(f.options), /unused source/);
    f.data.sources.pop();
    await writeFile(f.manifest, JSON.stringify({ ...f.data, mutation: [] }));
    await assert.rejects(stageChanges(f.options), /invalid staging manifest/);
    assert.equal(git(f.root, "diff", "--cached"), "");
  }));

  it("does not rebase or silently skip selected outside-repository mutations", async () => fixture(async f => {
    const outside = await f.source("outside", f.elsewhere, [f.edit("file.txt", "base", "wrong repository")]);
    f.data.sources.push(outside); f.data.mutations.push({ sessionId: "outside", resultEventId: "result-0" }); await f.save();
    const before = await readFile(join(f.root, ".git/index"));
    const report = await stageChanges(f.options);
    assert.match(report.conflicts[0]?.reason ?? "", /outside/);
    assert.deepEqual(report.staged, []);
    assert.deepEqual(await readFile(join(f.root, ".git/index")), before);
  }));

  it("validates source choice and calling session before publication", async () => fixture(async f => {
    await assert.rejects(stageChanges({ ...f.options, input: "unused" }), /exactly one/);
    await assert.rejects(stageChanges({ manifest: f.manifest, cwd: f.root }), /calling session/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(stageChanges({ ...f.options, signal: controller.signal }), /abort/i);
    assert.equal(git(f.root, "diff", "--cached"), "");
  }));
});
