#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHandoffSummary } from "../src/handoff/summary.js";
import { buildProbeBundle } from "../src/probe/build-bundle.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const casesPath = resolve(here, "benchmark-cases.json");

const casesFile = await readFile(casesPath, "utf8");
const cases = JSON.parse(casesFile).cases;

const records = [];
for (const caseItem of cases) {
  const bundle = await buildProbeBundle({ sessionPath: caseItem.session, devlogPath: caseItem.devlog });
  const summary = buildHandoffSummary(bundle);
  const expectedCommits = new Set(caseItem.expected?.commits ?? []);
  const matchedCommits = summary.commits.matched.filter((commit) => expectedCommits.has(commit));
  const extraCommits = summary.commits.matched.filter((commit) => !expectedCommits.has(commit));
  records.push({
    id: caseItem.id,
    session: relative(root, caseItem.session),
    devlog: relative(root, caseItem.devlog),
    expected: caseItem.expected,
    observed: {
      status: summary.status,
      outcome: summary.outcome,
      modified: summary.files.modified,
      readCount: summary.files.read.length,
      commands: summary.commands.total,
      failedCommands: summary.commands.failed,
      tests: summary.commands.tests,
      commitsMatched: summary.commits.matched,
      commitsExpected: summary.commits.expected,
      skills: summary.skills.names,
      explicitSkillCommands: summary.skills.explicitCommands,
      attributedRecords: summary.skills.attributedRecords,
    },
    evaluation: {
      statusMatch: summary.status === caseItem.expected?.status || (summary.status === "accepted" && caseItem.expected?.status === "stable"),
      commitMatch: matchedCommits.length,
      commitMissed: summary.commits.expected.filter((commit) => !summary.commits.matched.includes(commit)),
      commitExtra: extraCommits,
    },
    sizes: { source: summary.source.bytes },
  });
}

await writeFile(resolve(root, "docs/benchmark-report.json"), JSON.stringify(records, null, 2));

const lines = [];
lines.push("# Benchmark report");
lines.push("");
lines.push(`Cases: ${records.length}`);
lines.push("");
lines.push("| id | status (obs/exp) | outcome | modified | cmds | failed | tests | commits matched | skills | source bytes |");
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const record of records) {
  lines.push(`| ${record.id} | ${record.observed.status} / ${record.expected?.status ?? "?"} | ${record.observed.outcome} | ${record.observed.modified.length} | ${record.observed.commands} | ${record.observed.failedCommands} | ${record.observed.tests} | ${record.observed.commitsMatched.length} | ${record.observed.skills.length} | ${record.sizes.source} |`);
}
lines.push("");
lines.push("## Status evaluation");
for (const record of records) lines.push(`- ${record.id}: ${record.evaluation.statusMatch ? "matched" : `observed=${record.observed.status} expected=${record.expected?.status}`}`);
lines.push("");
lines.push("## Commit evaluation");
for (const record of records) {
  const matched = record.observed.commitsMatched.length;
  const expected = record.observed.commitsExpected.length;
  lines.push(`- ${record.id}: matched ${matched} of ${expected} expected`);
}

await writeFile(resolve(root, "docs/benchmark-report.md"), `${lines.join("\n")}\n`);
console.log(`Wrote ${records.length} benchmark records to docs/benchmark-report.json and docs/benchmark-report.md`);
