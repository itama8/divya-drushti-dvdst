import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { getCapabilities } from "../src/capabilities.js";
import { COMMANDS } from "../src/cli/commands.js";
import { CLI_OPTIONS, parserOptions } from "../src/cli/command-options.js";

const bin = resolve("bin/dvdst.mjs");
const cli = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", env: { ...process.env, DVDST_CACHE: "off" } });
function detail(name: string) {
  const entry = getCapabilities(name).commands[0]!;
  if (!("options" in entry)) throw new Error("Expected detailed capability entry");
  return entry;
}

describe("capability catalog", () => {
  it("lists every dispatchable built-in compactly and supports focused groups", () => {
    const catalog = getCapabilities();
    assert.equal(catalog.schemaVersion, 1);
    assert.deepEqual(catalog.commands.map(command => command.name), Object.keys(COMMANDS));
    assert.ok(catalog.commands.every(command => !("inputSchema" in command)), "default catalog does not dump every schema");
    const exploration = getCapabilities(undefined, "exploration");
    assert.ok(exploration.commands.some(command => command.name === "search"));
    assert.ok(exploration.commands.every(command => command.group === "exploration"));
    assert.ok(!exploration.commands.some(command => command.name === "cleanup"));
    assert.ok(getCapabilities().commands.some(command => command.name === "capabilities"));
  });

  it("describes safe value shapes, bounds, defaults, and source limits", () => {
    const search = detail("search");
    const input = JSON.parse(JSON.stringify(search.inputSchema));
    const options = input.properties.options;
    assert.deepEqual(options.required, ["query"]);
    assert.equal(options.properties.query.minLength, 1);
    assert.equal(options.properties.limit.type, "integer");
    assert.equal(options.properties.limit.default, 20);
    assert.equal(options.properties["text-limit"].maximum, 4096);
    assert.equal(options.additionalProperties, false);
    assert.equal(input.additionalProperties, false);
    assert.deepEqual(search.sessionSources, ["pi", "claude", "codex"]);
    assert.equal(detail("message").options.limit!.effectiveDefault, 2000);
    assert.equal(detail("call").options.limit!.effectiveDefault, 4096);
    assert.ok(!Object.hasOwn(detail("message").options, "source"));
    assert.equal(detail("message").options.format!.effectiveDefault, "json");
    assert.deepEqual(detail("sessions").sessionSources, ["pi"]);
    assert.deepEqual(detail("session-stage").sessionSources, ["claude", "codex"]);
    assert.deepEqual(detail("review").sessionSources, []);
    assert.ok(detail("review").limitations.some(limit => limit.includes("Pi")));
    assert.equal(detail("files").output.schema, null, "undeclared legacy schemas stay explicitly unknown");
    assert.equal(detail("schema").options.format!.effectiveDefault, "text");
  });

  it("exposes conditional material effects without implying staging commits", () => {
    assert.deepEqual(detail("capabilities").effects, []);
    assert.deepEqual(detail("search").effects, []);
    assert.equal(detail("calls").effects[0]!.kind, "cache-write");
    for (const name of ["rows", "schema"]) assert.equal(detail(name).effects[0]!.kind, "execute-code");
    assert.equal(detail("events").effects[0]!.kind, "store-write");
    assert.equal(detail("skills").effects[0]!.kind, "store-write");
    assert.equal(detail("probe").effects[0]!.kind, "file-write");
    assert.equal(detail("cleanup").effects[0]!.kind, "delete-store");
    const cleanupInput = JSON.parse(JSON.stringify(detail("cleanup").inputSchema));
    assert.equal(cleanupInput.properties.options.properties.yes.const, true);
    for (const name of ["stage", "session-stage"]) {
      const stage = detail(name);
      assert.equal(stage.effects[0]!.kind, "git-index-write");
      assert.match(stage.effects[0]!.when, /never commits/);
      assert.match(stage.effects[0]!.when, /dry-run/);
    }
  });

  it("uses live parser definitions for every advertised option", async () => {
    for (const [name, command] of Object.entries(COMMANDS)) {
      const source = await readFile(join("src/cli", command.script), "utf8");
      const parserKey = /options: parserOptions\(CLI_OPTIONS\.(\w+)\)/.exec(source)?.[1];
      assert.ok(parserKey, `${name} must use shared executable options`);
      const executable = CLI_OPTIONS[parserKey as keyof typeof CLI_OPTIONS];
      const parsed = parserOptions(executable);
      for (const [key, option] of Object.entries(command.options)) {
        assert.ok(Object.hasOwn(parsed, key), `${name} advertises unsupported --${key}`);
        const actual = parsed[key as keyof typeof parsed] as { type: string; short?: string; default?: unknown };
        assert.equal(actual.type, option.type, `${name} --${key} parser type`);
        assert.equal(actual.short, option.short, `${name} --${key} short alias`);
        assert.deepEqual(actual.default, option.default, `${name} --${key} parser default`);
        assert.ok(!Object.hasOwn(actual, "description"), "catalog metadata is not passed to Node");
      }
    }
  });

  it("shares field schemas with schema and does not expose mutable parser references", () => {
    for (const name of ["calls", "call", "messages", "message", "search", "capabilities"]) {
      const command = detail(name);
      const result = cli("schema", name, "--format", "json");
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(command.output.schema, JSON.parse(result.stdout)[name]);
    }
    const entry = detail("search");
    entry.options.query!.description = "mutated by consumer";
    assert.notEqual(detail("search").options.query!.description, "mutated by consumer");
  });

  it("never imports project extractors during catalog discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "dvdst-catalog-"));
    try {
      const extractors = join(root, ".dvdst", "extractors");
      await mkdir(extractors, { recursive: true });
      const marker = join(root, "executed");
      await writeFile(join(extractors, "search.mjs"), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); throw new Error('extractor was loaded');`);
      for (const args of [["capabilities"], ["capabilities", "search"], ["capabilities", "--group", "exploration"], ["schema", "capabilities", "--format", "json"]]) {
        const result = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        assert.doesNotThrow(() => JSON.parse(result.stdout));
      }
      await assert.rejects(stat(marker), { code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("runs fixture examples and supports catalog-driven search to neighborhood retrieval", () => {
    for (const command of Object.values(COMMANDS)) for (const args of command.examples) {
      if (!args.includes("test/fixtures/claude-session.jsonl")) continue;
      const result = cli(...args);
      assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
      assert.ok(result.stdout.length > 0);
    }
    const catalog = JSON.parse(cli("capabilities", "search").stdout).commands[0];
    const fields = catalog.output.schema.fields.map((field: { name: string }) => field.name);
    assert.ok(fields.includes("messageRef"));
    assert.ok(Object.hasOwn(catalog.inputSchema.properties.options.properties, "query"));
    const page = JSON.parse(cli("search", "test/fixtures/claude-session.jsonl", "--query", "parser", "--page").stdout);
    assert.equal(page.complete, true);
    const window = cli("message", "--ref", page.rows[0].messageRef, "--before", "0", "--after", "1", "--limit", "100");
    assert.equal(window.status, 0, window.stderr);
    assert.equal(JSON.parse(window.stdout).messages[0].role, "user");
  });

  it("validates catalog arguments and supports text output", () => {
    for (const args of [["missing"], ["__proto__"], ["--group", "missing"], ["search", "--group", "exploration"], ["search", "calls"], ["--format", "jsonl"]]) {
      const response = cli("capabilities", ...args);
      assert.equal(response.status, 1, args.join(" "));
      assert.equal(response.stdout, "");
    }
    const text = cli("capabilities", "search", "--format", "text");
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /--query:/);
    assert.match(text.stdout, /Output:/);
    assert.equal(cli("capabilities", "--help").status, 0);
    assert.match(cli("--help").stderr, /^  capabilities\s/m);
    const inherited = cli("constructor");
    assert.equal(inherited.status, 1);
    assert.match(inherited.stderr, /Unknown command or extractor/);
  });
});
