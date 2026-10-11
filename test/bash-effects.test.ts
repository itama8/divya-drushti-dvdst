import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { extractArtifacts } from "../src/artifacts/extract.js";
import { loadProjectConfig, parseConfig } from "../src/config/config.js";
import { extractEvents } from "../src/events/extract.js";
import { normalizeSnapshot } from "../src/normalize/normalize.js";
import { parseBashEffects } from "../src/pi/bash-effects.js";
import { classifyCommand } from "../src/pi/classify-commands.js";
import { extractCommitCandidates, extractCreatedCommits } from "../src/pi/extract-commits.js";
import { ingestSessionFile } from "../src/store/ingest-session.js";

function effects(command: string): string[] {
  return parseBashEffects(command).effects.map((effect) => `${effect.effect} ${effect.via} ${effect.path}`);
}

describe("bash file effects", () => {
  it("names files that read commands show", () => {
    assert.deepEqual(effects("cat src/a.ts"), ["read cat src/a.ts"]);
    assert.deepEqual(effects("sed -n '1,80p' src/a.ts | head -5"), ["read sed src/a.ts"]);
    assert.deepEqual(effects("head -n 20 a.md; tail -c 100 b.md"), ["read head a.md", "read tail b.md"]);
    assert.deepEqual(effects("awk -F'|' 'NR>3 {print $2}' docs/map.md"), ["read awk docs/map.md"]);
    assert.deepEqual(effects("jq -r --arg n x '.scripts' package.json"), ["read jq package.json"]);
    assert.deepEqual(effects("git show HEAD~1:src/a.ts"), ["read git show src/a.ts"]);
    assert.deepEqual(effects("wc -l < notes.txt"), ["read redirect notes.txt"]);
  });

  it("treats a search operand as a read only when it names a file", () => {
    assert.deepEqual(effects("rg -n 'foo|bar' src/main.ts src/ -g '*.ts'"), ["read rg src/main.ts"]);
    assert.deepEqual(effects("grep -rn -A 3 needle lib"), []);
    assert.deepEqual(effects("rg -e one -e two src/a.ts"), ["read rg src/a.ts"]);
  });

  it("names files that mutating commands change", () => {
    assert.deepEqual(effects("sed -i 's/a/b/' src/a.ts src/b.ts"), ["mutation sed -i src/a.ts", "mutation sed -i src/b.ts"]);
    assert.deepEqual(effects("echo hi > out.txt 2>&1"), ["mutation redirect out.txt"]);
    assert.deepEqual(effects("npm test 2> err.log | tee -a run.log"), ["mutation redirect err.log", "mutation tee run.log"]);
    assert.deepEqual(effects("rm -f a.tmp && mv old.ts new.ts"), ["mutation rm a.tmp", "mutation mv old.ts", "mutation mv new.ts"]);
    assert.deepEqual(effects("git checkout HEAD -- src/a.ts"), ["mutation git checkout src/a.ts"]);
    assert.deepEqual(effects("perl -pi -e 's/a/b/' x.md"), ["mutation perl -i x.md"]);
    assert.deepEqual(effects("echo x > /dev/null"), []);
  });

  it("follows literal cd steps and git -C", () => {
    assert.deepEqual(effects("cd /repo && cat src/a.ts"), ["read cat /repo/src/a.ts"]);
    assert.deepEqual(effects("cd docs && cat ../README.md"), ["read cat README.md"]);
    assert.deepEqual(effects("git -C /repo show HEAD:a.ts"), ["read git show /repo/a.ts"]);
    assert.deepEqual(effects("bash -c 'cd pkg && sed -i s/a/b/ index.ts'"), ["mutation sed -i pkg/index.ts"]);
  });

  it("ignores heredoc bodies and keeps the heredoc target", () => {
    const parsed = parseBashEffects("cat > notes.md <<'EOF'\nrm -rf /\ncat secret.txt\nEOF\ncat after.md");
    assert.deepEqual(parsed.effects.map((effect) => `${effect.effect} ${effect.path}`), ["mutation notes.md", "read after.md"]);
  });

  it("reports what it cannot name instead of guessing", () => {
    assert.deepEqual(parseBashEffects('rm "$TARGET"'), { effects: [], opaque: ["rm with a computed path"], verbs: ["rm"] });
    assert.deepEqual(parseBashEffects("python3 - <<'PY'\nopen('x','w')\nPY"), { effects: [], opaque: ["inline python3 script"], verbs: ["python3"] });
    assert.deepEqual(parseBashEffects("node -e 'fs.writeFileSync(1)'").opaque, ["inline node script"]);
    assert.deepEqual(parseBashEffects("git apply fix.patch").opaque, ["git apply may rewrite the worktree"]);
    assert.deepEqual(parseBashEffects('cd "$DIR" && echo x > out.txt'), { effects: [], opaque: ["redirect after a cd that cannot be followed"], verbs: ["echo"] });
    assert.deepEqual(parseBashEffects('cat "$F" src/*.ts'), { effects: [], opaque: [], verbs: ["cat"] }, "an unnamed read is not a risk");
    assert.deepEqual(parseBashEffects("node scripts/build.mjs"), { effects: [], opaque: [], verbs: ["node"] });
  });

  it("lists the programs a command runs", () => {
    const verbs = (command: string): string[] => parseBashEffects(command).verbs;
    assert.deepEqual(verbs("cd /repo && git -C sub diff --stat | head -5; npm run --silent build && npm test"), ["git diff", "head", "npm run build", "npm test"]);
    assert.deepEqual(verbs("FOO=1 timeout 60 node scripts/x.mjs 2>&1 | tail -3"), ["node", "tail"]);
    assert.deepEqual(verbs("for f in a b; do rg -n x \"$f\"; done; rg y"), ["rg"]);
    assert.deepEqual(verbs("bash -c 'ls && cat a.md'"), ["ls", "cat"]);
  });
});

describe("project config", () => {
  const text = JSON.stringify({
    commandClasses: [{ name: "test", pattern: "node scripts/[\\w-]+-contract\\.mjs", reason: "contract script" }, { name: "probe", pattern: "ui-probe" }],
    findings: { ignorePaths: ["^\\.devlog/"] },
  });

  it("adds project command classes after the built-in rules", () => {
    const config = parseConfig(text, "config.json");
    assert.deepEqual(classifyCommand("node scripts/x-contract.mjs"), []);
    assert.deepEqual(classifyCommand("node scripts/x-contract.mjs", config.commandClasses), ["test"]);
    assert.deepEqual(classifyCommand("npm test && node scripts/x-contract.mjs", config.commandClasses), ["test"], "one class per name");
    assert.deepEqual(classifyCommand("npm run ui-probe", config.commandClasses), ["probe"]);
    assert.match(config.sha256!, /^[0-9a-f]{64}$/);
  });

  it("recognizes common test runners without configuration", () => {
    for (const command of ["npm test", "npm run test:unit", "tsx --test test/a.test.ts", "node --import tsx --test", "go test ./...", "bun test", "pytest -q"]) {
      assert.deepEqual(classifyCommand(command), ["test"], command);
    }
    assert.deepEqual(classifyCommand("cat test/a.ts"), []);
  });

  it("loads the file from the session cwd and rejects a broken one", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dvdst-config-"));
    assert.equal((await loadProjectConfig({ cwd })).path, null);
    await mkdir(join(cwd, ".dvdst"));
    await writeFile(join(cwd, ".dvdst", "config.json"), text);
    const loaded = await loadProjectConfig({ cwd });
    assert.equal(loaded.commandClasses.length, 2);
    assert.equal(loaded.ignorePaths.length, 1);
    assert.throws(() => parseConfig('{"commandClasses":[{"name":"test","pattern":"("}]}', "c.json"), /not a valid regular expression/);
    assert.throws(() => parseConfig('{"classes":[]}', "c.json"), /unknown key "classes"/);
  });
});

describe("commit detection", () => {
  const output = "[master 1a2b3c4] fix: thing\n 2 files changed\nblob deadbeef1234 and tree cafebabe9876\n[detached HEAD 9f8e7d6c] wip";

  it("separates commits the session created from hexadecimal words", () => {
    assert.deepEqual(extractCreatedCommits(output), ["1a2b3c4", "9f8e7d6c"]);
    assert.equal(extractCommitCandidates(output).length, 4);
  });
});

describe("findings with bash evidence", () => {
  const cwd = "/work/app";
  const header = { type: "session", version: 3, id: "bash-findings", timestamp: "2026-08-04T00:00:00.000Z", cwd };
  let counter = 0;
  function step(name: string, args: unknown, isError = false): unknown[] {
    counter += 1;
    const id = `call-${counter}`;
    return [
      { type: "message", id: `a${counter}`, timestamp: "2026-08-04T00:00:00.000Z", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } },
      { type: "message", id: `r${counter}`, timestamp: "2026-08-04T00:00:00.000Z", message: { role: "toolResult", toolCallId: id, toolName: name, isError, content: [{ type: "text", text: "ok" }] } },
    ];
  }

  async function run(entries: unknown[], configText?: string): Promise<{ findings: Array<Record<string, unknown>>; effects: Array<Record<string, unknown>>; config: unknown }> {
    const root = await mkdtemp(join(tmpdir(), "dvdst-bash-findings-"));
    const store = join(root, "store");
    const source = join(root, "session.jsonl");
    await writeFile(source, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    const configPath = join(root, "config.json");
    if (configText !== undefined) await writeFile(configPath, configText);
    const config = configText === undefined ? {} : { configPath };
    const ingested = await ingestSessionFile(source, store);
    await normalizeSnapshot({ store, sessionId: ingested.sessionId });
    await extractArtifacts({ store, sessionId: ingested.sessionId, ...config });
    const events = await extractEvents({ store, sessionId: ingested.sessionId, ...config });
    const jsonl = async (path: string): Promise<Array<Record<string, unknown>>> =>
      (await readFile(join(events.snapshot, path), "utf8")).split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
    const derived = JSON.parse(await readFile(join(events.snapshot, "derived-events.json"), "utf8")) as { config: unknown };
    return {
      findings: (await jsonl("events/deterministic.jsonl")).filter((row) => String(row.kind).startsWith("finding")),
      effects: await jsonl("artifacts/bash-file-effects.jsonl"),
      config: derived.config,
    };
  }

  const entries = (): unknown[] => [
    header,
    ...step("bash", { command: "cd /work/app && sed -n '1,40p' src/seen.ts" }),
    ...step("bash", { command: "cat src/failed.ts" }, true),
    ...step("edit", { path: "/work/app/src/seen.ts", edits: [{ oldText: "a", newText: "b" }] }),
    ...step("edit", { path: "src/failed.ts", edits: [{ oldText: "a", newText: "b" }] }),
    ...step("edit", { path: "src/unseen.ts", edits: [{ oldText: "a", newText: "b" }] }),
    ...step("bash", { command: "node scripts/app-contract.mjs" }),
    ...step("write", { path: ".devlog/today.md", content: "log" }),
    ...step("write", { path: "/tmp/scratch.json", content: "{}" }),
  ];

  it("counts a successful bash read and keeps scratch files out of findings", async () => {
    const { findings, effects } = await run(entries());
    assert.deepEqual(effects.map((effect) => [effect.effect, effect.resolvedPath, effect.succeeded, effect.confidence]), [
      ["read", "/work/app/src/seen.ts", true, "inferred"],
      ["read", "/work/app/src/failed.ts", false, "inferred"],
    ]);
    const unread = findings.filter((finding) => finding.finding === "file-modified-without-observed-read");
    assert.deepEqual(unread.map((finding) => [finding.path, finding.operation]), [
      ["src/failed.ts", "edit"],
      ["src/unseen.ts", "edit"],
      [".devlog/today.md", "write"],
    ]);
    const untested = findings.find((finding) => finding.finding === "tests-not-run-after-final-mutation");
    assert.equal(untested?.finalMutationPath, ".devlog/today.md", "the write outside the session cwd is not the final mutation");
    assert.equal(untested?.testsSeen, false, "the contract script is not a test without project rules");
  });

  it("applies project command classes and ignored paths", async () => {
    const configText = JSON.stringify({ commandClasses: [{ name: "test", pattern: "-contract\\.mjs" }], findings: { ignorePaths: ["^\\.devlog/"] } });
    const { findings, config } = await run(entries(), configText);
    assert.deepEqual(findings.filter((finding) => finding.finding === "file-modified-without-observed-read").map((finding) => finding.path), ["src/failed.ts", "src/unseen.ts"]);
    assert.equal(findings.some((finding) => finding.finding === "tests-not-run-after-final-mutation"), false, "the contract script ran after the last project mutation");
    assert.match((config as { sha256: string }).sha256, /^[0-9a-f]{64}$/);
  });
});
