#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHandoffSummary, handoffToText } from "../src/handoff/summary.js";
import { buildProbeBundle } from "../src/probe/build-bundle.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const casesPath = resolve(here, "benchmark-cases.json");

/**
 * Documents a coarse token estimate: roughly one token per four bytes, the
 * standard heuristic for English prose and JSON. The benchmark reports the
 * number next to the byte counts so readers have a comparable unit; it is not
 * a tokenizer result and should be labelled as an estimate in any report.
 */
function estimateTokens(bytes) {
  return Math.max(1, Math.round(bytes / 4));
}

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

const casesFile = await readFile(casesPath, "utf8");
const cases = JSON.parse(casesFile).cases;

const records = [];
for (const caseItem of cases) {
  const bundle = await buildProbeBundle({ sessionPath: caseItem.session, devlogPath: caseItem.devlog });
  const summary = buildHandoffSummary(bundle);
  const summaryText = handoffToText(summary);
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
    sizes: {
      sourceBytes: summary.source.bytes,
      bundleBytes: serializedBytes(bundle),
      summaryBytes: Buffer.byteLength(summaryText),
      sourceEstimatedTokens: estimateTokens(summary.source.bytes),
      bundleEstimatedTokens: estimateTokens(serializedBytes(bundle)),
      summaryEstimatedTokens: estimateTokens(Buffer.byteLength(summaryText)),
    },
  });
}

await writeFile(resolve(root, "docs/benchmark-report.json"), JSON.stringify(records, null, 2));

const lines = [];
lines.push("# Benchmark report");
lines.push("");
lines.push(`Cases: ${records.length}`);
lines.push("");
lines.push("| id | status (obs/exp) | outcome | modified | cmds | failed | tests | commits matched | skills | source bytes | est. tokens |");
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const record of records) {
  lines.push(`| ${record.id} | ${record.observed.status} / ${record.expected?.status ?? "?"} | ${record.observed.outcome} | ${record.observed.modified.length} | ${record.observed.commands} | ${record.observed.failedCommands} | ${record.observed.tests} | ${record.observed.commitsMatched.length} | ${record.observed.skills.length} | ${record.sizes.sourceBytes} | ${record.sizes.sourceEstimatedTokens} |`);
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
lines.push("");
lines.push("## Context reduction");
const tableLines = ["| id | source bytes | bundle bytes | summary bytes | source→summary reduction |"];
tableLines.push("| --- | --- | --- | --- | --- |");
for (const record of records) {
  const ratio = record.sizes.sourceBytes / Math.max(1, record.sizes.summaryBytes);
  tableLines.push(`| ${record.id} | ${record.sizes.sourceBytes} | ${record.sizes.bundleBytes} | ${record.sizes.summaryBytes} | ${ratio.toFixed(0)}× |`);
}
lines.push(...tableLines);
lines.push("");
lines.push("Token estimates use the ≈1 token per 4 bytes heuristic; they are not tokenizer output.");

await writeFile(resolve(root, "docs/benchmark-report.md"), `${lines.join("\n")}\n`);
console.log(`Wrote ${records.length} benchmark records to docs/benchmark-report.json and docs/benchmark-report.md`);
