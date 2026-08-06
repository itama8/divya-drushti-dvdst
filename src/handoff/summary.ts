import type { ProbeBundle } from "../probe/build-bundle.js";

type JsonObject = Record<string, unknown>;

export interface HandoffSummary {
  schemaVersion: string;
  session: JsonObject;
  status: "accepted" | "user-testing" | "blocked" | "regressed" | "planned" | "closed" | "unknown";
  outcome: "stable" | "no-test-evidence" | "no-validation" | "test-failed" | "unresolved-failure" | "unknown";
  source: JsonObject;
  goals: JsonObject[];
  files: { modified: string[]; read: string[] };
  commands: { total: number; byClass: Record<string, number>; failed: number; tests: number };
  tests: { ran: boolean; failures: number; commands: number };
  commits: { expected: string[]; matched: string[]; missing: string[]; observed: string[]; additional: string[] };
  skills: { names: string[]; explicitCommands: number; loadCandidates: number; attributedRecords: number };
  devlog?: { status: string | null; path: string; expected: string[]; matched: string[]; missing: string[] };
  nextFiles: { expected: string[]; matchedModified: string[] };
}

interface DevlogComparison {
  path: string;
  expected: { status: string | undefined; contractsTouched: string[]; commits: string[]; nextFiles: string[] };
  observed: { mutatedPaths: string[]; commitCandidates: string[] };
  contractsTouched: { matched: string[]; missingFromObservedMutations: string[] };
  commits: { matched: string[]; missingFromCandidates: string[]; additionalCandidates: string[] };
}

function classifyOutcome(failedCommands: number, testCommands: number, matchedCommits: number, expectedCommits: number): HandoffSummary["outcome"] {
  if (failedCommands > 0) return "unresolved-failure";
  if (testCommands === 0 && expectedCommits === 0) return "no-validation";
  if (testCommands === 0) return "no-test-evidence";
  if (expectedCommits > 0 && matchedCommits === 0) return "no-test-evidence";
  return "stable";
}

function classifyStatus(devlog: { status: string | null } | undefined): HandoffSummary["status"] {
  if (!devlog || !devlog.status) return "unknown";
  const expected = devlog.status;
  if (expected === "accepted" || expected === "closed") return expected;
  if (expected === "stable" || expected === "accepted-linux" || expected === "accepted-fixture") return "accepted";
  if (expected === "user-testing") return "user-testing";
  if (expected === "blocked") return "blocked";
  if (expected === "regressed") return "regressed";
  if (expected === "planned") return "planned";
  return "unknown";
}

export function buildHandoffSummary(bundle: ProbeBundle): HandoffSummary {
  const commands = bundle.commands as Array<{ classes: string[]; result?: { isError: boolean } }>;
  const commandClasses = new Map<string, number>();
  let failedCommands = 0;
  let testCommands = 0;
  for (const command of commands) {
    for (const klass of command.classes) commandClasses.set(klass, (commandClasses.get(klass) ?? 0) + 1);
    if (command.classes.includes("test")) testCommands += 1;
    if (command.result?.isError) failedCommands += 1;
  }

  const files = bundle.files as Array<{ path: string; operations: string[] }>;
  const readFiles = files.filter((file) => file.operations.includes("read")).map((file) => file.path);
  const modifiedFiles = files.filter((file) => file.operations.some((operation) => operation === "edit" || operation === "write")).map((file) => file.path);

  const skills = bundle.skills;
  const invocations = skills.invocations as Array<{ name: string; mode: string }>;
  const explicit = invocations.filter((skill) => skill.mode === "explicit-command").length;
  const candidates = invocations.length - explicit;

  const devlogComparison = bundle.devlogComparison as DevlogComparison | undefined;
  const devlogSummary: HandoffSummary["devlog"] = devlogComparison
    ? {
        status: devlogComparison.expected.status ?? null,
        path: devlogComparison.path,
        expected: devlogComparison.expected.contractsTouched,
        matched: devlogComparison.contractsTouched.matched,
        missing: devlogComparison.contractsTouched.missingFromObservedMutations,
      }
    : undefined;

  const nextFilesExpected = devlogComparison?.expected.nextFiles ?? [];
  const nextFilesMatched = nextFilesExpected.filter((path) => modifiedFiles.includes(path));

  const matchedCommits = devlogComparison ? [...new Set(devlogComparison.commits.matched)] : [];
  const expectedCommits = devlogComparison?.expected.commits ?? [];

  return {
    schemaVersion: "0.1.0-handoff",
    session: bundle.session as JsonObject,
    status: classifyStatus(devlogSummary),
    outcome: classifyOutcome(failedCommands, testCommands, matchedCommits.length, expectedCommits.length),
    source: {
      path: (bundle.session as { sourcePath: string }).sourcePath,
      bytes: (bundle.session as { sourceBytes: number }).sourceBytes,
      lines: (bundle.session as { sourceLines: number }).sourceLines,
    },
    goals: bundle.goals,
    files: { modified: modifiedFiles, read: readFiles },
    commands: {
      total: commands.length,
      byClass: Object.fromEntries(commandClasses),
      failed: failedCommands,
      tests: testCommands,
    },
    tests: {
      ran: testCommands > 0,
      failures: commands.filter((command) => command.classes.includes("test") && command.result?.isError === true).length,
      commands: testCommands,
    },
    commits: {
      expected: expectedCommits,
      matched: matchedCommits,
      missing: devlogComparison?.commits.missingFromCandidates ?? [],
      observed: devlogComparison?.observed.commitCandidates ?? bundle.commitCandidates,
      additional: devlogComparison?.commits.additionalCandidates ?? [],
    },
    skills: {
      names: invocations.map((skill) => skill.name),
      explicitCommands: explicit,
      loadCandidates: candidates,
      attributedRecords: (skills.attributedRecords as unknown[]).length,
    },
    ...(devlogSummary ? { devlog: devlogSummary } : {}),
    nextFiles: { expected: nextFilesExpected, matchedModified: nextFilesMatched },
  };
}

export function handoffToText(summary: HandoffSummary): string {
  const lines: string[] = [];
  lines.push(`Session: ${summary.session.id}`);
  lines.push(`Status: ${summary.status}`);
  lines.push(`Outcome: ${summary.outcome}`);
  lines.push(`Source: ${summary.source.path}`);
  lines.push(`Size: ${summary.source.bytes} bytes / ${summary.source.lines} lines`);

  lines.push("");
  lines.push("Goals:");
  for (const goal of summary.goals) {
    const text = (goal as { text: string }).text;
    lines.push(`- ${text.replace(/\s+/g, " ")}`);
  }

  lines.push("");
  lines.push(`Modified files (${summary.files.modified.length}):`);
  for (const file of summary.files.modified) lines.push(`- ${file}`);

  if (summary.files.read.length > 0) {
    lines.push("");
    lines.push(`Read files (${summary.files.read.length}, first 5):`);
    for (const file of summary.files.read.slice(0, 5)) lines.push(`- ${file}`);
  }

  lines.push("");
  lines.push(`Commands: total=${summary.commands.total} failed=${summary.commands.failed} tests=${summary.commands.tests}`);
  for (const [klass, count] of Object.entries(summary.commands.byClass)) lines.push(`- ${klass}: ${count}`);

  lines.push("");
  lines.push(`Tests: ran=${summary.tests.ran} failures=${summary.tests.failures}`);

  if (summary.skills.names.length > 0) {
    lines.push("");
    lines.push(`Skills (${summary.skills.names.length}): explicit=${summary.skills.explicitCommands} load=${summary.skills.loadCandidates}`);
    for (const name of summary.skills.names) lines.push(`- ${name}`);
    lines.push(`Attributed records: ${summary.skills.attributedRecords}`);
  }

  if (summary.commits.expected.length > 0 || summary.commits.observed.length > 0) {
    lines.push("");
    lines.push(`Commits: matched=${summary.commits.matched.length} expected=${summary.commits.expected.length} observed=${summary.commits.observed.length}`);
    for (const commit of summary.commits.matched) lines.push(`- matched ${commit}`);
    for (const commit of summary.commits.missing) lines.push(`- missing ${commit}`);
    if (summary.commits.matched.length === 0) {
      for (const commit of summary.commits.observed) lines.push(`- observed ${commit}`);
    } else if (summary.commits.additional.length > 0) {
      lines.push(`- additional candidates: ${summary.commits.additional.length}`);
    }
  }

  if (summary.devlog) {
    lines.push("");
    lines.push(`Devlog: ${summary.devlog.path}`);
    if (summary.devlog.status) lines.push(`Devlog status: ${summary.devlog.status}`);
    lines.push(`Contracts matched: ${summary.devlog.matched.length} missing: ${summary.devlog.missing.length}`);
  }

  if (summary.nextFiles.expected.length > 0) {
    lines.push("");
    lines.push(`Next files matched: ${summary.nextFiles.matchedModified.length}/${summary.nextFiles.expected.length}`);
  }

  return `${lines.join("\n")}\n`;
}
