import type { Row } from "../analysis/rows.js";
import { createHash } from "node:crypto";

export function summarizeValidation(calls: Row[]) {
  const tests = calls.filter(row => (row.classes as string[]).includes("test"));
  const latestCommands = new Map<string, Row>();
  const successfulStarts = new Map<string, number>();
  // Compare recorded arguments as well as command text: a different workdir
  // or environment cannot clear a previous failure of the same command text.
  for (const row of calls) if (typeof row.command === "string") {
    const key = JSON.stringify(row.args);
    latestCommands.set(key, row);
    if (row.isError === false) successfulStarts.set(key, Math.max(successfulStarts.get(key) ?? 0, row.line as number));
  }
  const unresolved = calls.filter(row => typeof row.command === "string" && row.isError === true
    && (successfulStarts.get(JSON.stringify(row.args)) ?? 0) <= (row.resultLine as number));
  const mutations = calls.filter(row => (row.mutates as string[]).length > 0 || (row.opaque as string[]).length > 0);
  // Even a failed shell command may have partially changed files. A missing
  // mutation result cannot establish a settled validation boundary.
  const boundary = mutations.reduce((last, row) => Math.max(last, typeof row.resultLine === "number" ? row.resultLine : Infinity), 0);
  const successfulAfterMutation = tests.filter(row => row.isError === false && (row.line as number) > boundary);
  const evidence = (row: Row) => ({ callId: row.callId, seq: row.seq, line: row.line, resultLine: row.resultLine, ref: row.ref, isError: row.isError });
  return {
    attempted: tests.length,
    completed: tests.filter(row => row.isError !== null).length,
    passed: tests.filter(row => row.isError === false).length,
    failed: tests.filter(row => row.isError === true).length,
    unfinished: tests.filter(row => row.isError === null).length,
    unfinishedCalls: calls.filter(row => row.isError === null).length,
    latestCommands: [...latestCommands.values()].map(row => ({ commandPreview: Array.from(row.command as string).slice(0, 200).join(""), argumentsHash: createHash("sha256").update(JSON.stringify(row.args)).digest("hex"), classes: row.classes as string[], ...evidence(row) })),
    unresolvedFailures: unresolved.map(evidence),
    lastMutation: mutations.length === 0 ? null : evidence(mutations.at(-1)!),
    opaqueEffects: calls.filter(row => (row.opaque as string[]).length > 0).map(evidence),
    passedAfterLastMutation: successfulAfterMutation.map(evidence),
  };
}
