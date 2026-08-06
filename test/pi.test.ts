import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDevlogFrontmatter } from "../src/pi/parse-devlog.js";
import { parseSkillBlock, skillNameFromContent } from "../src/pi/skill-block.js";
import { classifyCommand } from "../src/pi/classify-commands.js";
import { extractCommitCandidates } from "../src/pi/extract-commits.js";
import { normalizeSessionPath } from "../src/pi/normalize-paths.js";

describe("Pi helpers", () => {
  it("parses a devlog frontmatter", () => {
    const text = `---
status: accepted
contracts_touched:
  - src/a.ts
  - src/b.ts
commits:
  - abcdef1234567890abcdef1234567890abcdef12
next_files:
  - src/a.ts
---
`;
    const parsed = parseDevlogFrontmatter(text);
    assert.equal(parsed.status, "accepted");
    assert.deepEqual(parsed.contractsTouched, ["src/a.ts", "src/b.ts"]);
    assert.deepEqual(parsed.commits, ["abcdef1234567890abcdef1234567890abcdef12"]);
    assert.deepEqual(parsed.nextFiles, ["src/a.ts"]);
  });

  it("parses a skill block", () => {
    const text = '<skill name="foo" location="/skills/foo/SKILL.md">\nbody\n</skill>\n\nNext task';
    const block = parseSkillBlock(text);
    assert.deepEqual(block, { name: "foo", path: "/skills/foo/SKILL.md", body: "body", userMessage: "Next task" });
  });

  it("extracts skill name from frontmatter", () => {
    const body = "---\nname: bar\ndescription: x\n---\n\n# bar";
    assert.equal(skillNameFromContent(body, "/x/bar/SKILL.md"), "bar");
    assert.equal(skillNameFromContent("# fallback", "/x/baz/SKILL.md"), "baz");
  });

  it("classifies commands", () => {
    assert.deepEqual(classifyCommand("npm test"), ["test"]);
    assert.deepEqual(classifyCommand("cargo test -p foo"), ["test"]);
    assert.deepEqual(classifyCommand("npm run typecheck"), ["typecheck"]);
    assert.deepEqual(classifyCommand("npm run build"), ["build"]);
    assert.deepEqual(classifyCommand("echo hi"), []);
  });

  it("extracts commit candidates", () => {
    const sample = "[main abc1234567890abcdef1234567890abcdef1234] message\nabcdef1234567890abcdef1234567890abcdef12\nrandom 1234567 token";
    const candidates = extractCommitCandidates(sample);
    assert.ok(candidates.includes("abc1234567890abcdef1234567890abcdef1234"));
    assert.ok(candidates.includes("abcdef1234567890abcdef1234567890abcdef12"));
    assert.ok(candidates.includes("1234567"));
  });

  it("normalizes session paths against the project", () => {
    assert.equal(normalizeSessionPath("/home/me/proj/src/a.ts", "/home/me/proj"), "src/a.ts");
    assert.equal(normalizeSessionPath("/home/me/proj/.pi/skills/x/SKILL.md", "/home/me/proj"), ".pi/skills/x/SKILL.md");
    assert.equal(normalizeSessionPath("/etc/other.ts", "/home/me/proj"), "/etc/other.ts");
    assert.equal(normalizeSessionPath("src/a.ts", "/home/me/proj"), "src/a.ts");
  });
});
