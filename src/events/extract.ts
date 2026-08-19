import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isObject, type SourceReference } from "../pi/read-jsonl.js";
import { writeAtomic } from "../store/fs-util.js";
import { readSessionSnapshot } from "../store/read-session.js";

export const EVENT_EXTRACTOR = "pi-events";
export const EVENT_EXTRACTOR_VERSION = 1;

export interface EventsResult {
  schemaVersion: 1;
  kind: "events";
  extractor: { name: string; version: number };
  store: string;
  sessionId: string;
  sourceHash: string;
  snapshot: string;
  status: "complete";
  counts: {
    commands: number;
    commandSucceeded: number;
    commandFailed: number;
    commandsWithoutOutcome: number;
    fileReads: number;
    fileMutations: number;
    findings: number;
  };
  findings: {
    modifiedWithoutObservedRead: number;
    testsNotRunAfterFinalMutation: number;
    unresolvedCommandFailures: number;
    resolvedRetries: number;
  };
  diagnostics: { line: number; message: string }[];
}

interface CommandArtifact {
  schemaVersion: number;
  kind: "command";
  toolCallId: string;
  command: string;
  commandPreview: string;
  commandBytes: number;
  commandHash: string;
  result: { isError: boolean; outputBytes: number } | null;
  classifications: Array<{ name: string; reason: string; version: number }>;
  source: SourceReference;
}

interface FileReadArtifact {
  schemaVersion: number;
  kind: "file-read";
  path: string;
  toolCallId: string;
  requestedRange: { offset?: number; limit?: number };
  returnedBytes: number;
  succeeded: boolean | null;
  source: SourceReference;
}

interface FileMutationArtifact {
  schemaVersion: number;
  kind: "file-mutation";
  path: string;
  toolCallId: string;
  operation: string;
  contentBytes?: number;
  patch?: { observed: boolean; exact: boolean; reason: string };
  succeeded: boolean | null;
  source: SourceReference;
}

interface TestRunArtifact {
  schemaVersion: number;
  kind: "test-run";
  toolCallId: string;
  command: string;
  source: SourceReference;
}

interface OrderedEvent {
  line: number;
  record: unknown;
}

class JsonlRows {
  constructor(private readonly text: string, private readonly filename: string) {}

  parse<T>(): T[] {
    const rows: T[] = [];
    for (const [index, line] of this.text.split(/\r?\n/).entries()) {
      if (line.trim().length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`${this.filename} line ${index + 1}: invalid JSON: ${reason}`);
      }
      if (!isObject(value)) throw new Error(`${this.filename} line ${index + 1}: not a JSON object`);
      rows.push(value as T);
    }
    return rows;
  }
}

function event(kind: string, body: Record<string, unknown>): Record<string, unknown> {
  return { schemaVersion: 1, kind, confidence: "observed", ...body };
}

/**
 * Turns normalized command and file artifacts into deterministic events and
 * derived findings.
 *
 * events/deterministic.jsonl   command-succeeded, command-failed, file-read,
 *                              file-mutation, and finding records, in source
 *                              order. Findings are appended last.
 *
 * The extractor is deterministic and idempotent. Events are observed facts
 * from the tool records. Findings are derived claims that state their rule,
 * their limit, and the evidence they use. Confidence never exceeds what the
 * source can support.
 */
export async function extractEvents(options: {
  store: string;
  sessionId: string;
  sourceHash?: string;
}): Promise<EventsResult> {
  const store = resolve(options.store);
  const snapshotInfo = await readSessionSnapshot(options);
  const artifactsDirectory = join(snapshotInfo.path, "artifacts");
  const parse = async <T>(filename: string): Promise<T[]> => {
    const text = await readFile(join(artifactsDirectory, filename), "utf8");
    return new JsonlRows(text, filename).parse<T>();
  };

  const commands = await parse<CommandArtifact>("commands.jsonl");
  const fileReads = await parse<FileReadArtifact>("file-reads.jsonl");
  const fileMutations = await parse<FileMutationArtifact>("file-mutations.jsonl");
  const tests = await parse<TestRunArtifact>("tests.jsonl");

  const ordered: OrderedEvent[] = [];
  const diagnostics: { line: number; message: string }[] = [];
  let commandSucceeded = 0;
  let commandFailed = 0;
  let commandsWithoutOutcome = 0;

  for (const commandArtifact of commands) {
    const result = commandArtifact.result;
    if (result === null) {
      commandsWithoutOutcome += 1;
      diagnostics.push({ line: commandArtifact.source.line, message: `command ${commandArtifact.toolCallId} has no observed result; no success or failure event emitted` });
      continue;
    }
    const classificationNames = commandArtifact.classifications.map((classification) => classification.name);
    if (result.isError) {
      commandFailed += 1;
      ordered.push({
        line: commandArtifact.source.line,
        record: event("command-failed", {
          toolCallId: commandArtifact.toolCallId,
          command: commandArtifact.command,
          commandHash: commandArtifact.commandHash,
          commandPreview: commandArtifact.commandPreview,
          commandBytes: commandArtifact.commandBytes,
          resultBytes: result.outputBytes,
          classifications: classificationNames,
          source: commandArtifact.source,
          evidence: { artifact: "commands.jsonl", toolCallId: commandArtifact.toolCallId },
        }),
      });
    } else {
      commandSucceeded += 1;
      ordered.push({
        line: commandArtifact.source.line,
        record: event("command-succeeded", {
          toolCallId: commandArtifact.toolCallId,
          command: commandArtifact.command,
          commandHash: commandArtifact.commandHash,
          commandPreview: commandArtifact.commandPreview,
          commandBytes: commandArtifact.commandBytes,
          resultBytes: result.outputBytes,
          classifications: classificationNames,
          source: commandArtifact.source,
          evidence: { artifact: "commands.jsonl", toolCallId: commandArtifact.toolCallId },
        }),
      });
    }
  }

  for (const readArtifact of fileReads) {
    const observed = readArtifact.succeeded !== null;
    ordered.push({
      line: readArtifact.source.line,
      record: event("file-read", {
        path: readArtifact.path,
        toolCallId: readArtifact.toolCallId,
        requestedRange: readArtifact.requestedRange,
        returnedBytes: readArtifact.returnedBytes,
        succeeded: readArtifact.succeeded,
        observed,
        source: readArtifact.source,
        evidence: { artifact: "file-reads.jsonl", toolCallId: readArtifact.toolCallId },
      }),
    });
  }

  for (const mutationArtifact of fileMutations) {
    const observed = mutationArtifact.succeeded !== null;
    ordered.push({
      line: mutationArtifact.source.line,
      record: event("file-mutation", {
        path: mutationArtifact.path,
        toolCallId: mutationArtifact.toolCallId,
        operation: mutationArtifact.operation,
        observed,
        succeeded: mutationArtifact.succeeded,
        ...(mutationArtifact.contentBytes === undefined ? {} : { contentBytes: mutationArtifact.contentBytes }),
        ...(mutationArtifact.patch === undefined ? {} : { patch: mutationArtifact.patch }),
        source: mutationArtifact.source,
        evidence: { artifact: "file-mutations.jsonl", toolCallId: mutationArtifact.toolCallId },
      }),
    });
  }

  // --- Findings (derived claims, appended last, confidence: inferred) ---

  const confirmedMutations = fileMutations.filter((mutation) => mutation.succeeded === true);
  const successfulReads = fileReads.filter((read) => read.succeeded === true);
  const readLinesByPath = new Map<string, number[]>();
  for (const read of successfulReads) {
    const lines = readLinesByPath.get(read.path) ?? [];
    lines.push(read.source.line);
    readLinesByPath.set(read.path, lines);
  }
  const unconfirmedReadRequestsByPath = new Map<string, number>();
  for (const read of fileReads) {
    if (read.succeeded !== true) {
      unconfirmedReadRequestsByPath.set(read.path, (unconfirmedReadRequestsByPath.get(read.path) ?? 0) + 1);
    }
  }

  const findingRecords: OrderedEvent[] = [];
  const firstMutationLineByPath = new Map<string, number>();
  for (const mutation of confirmedMutations) {
    const known = firstMutationLineByPath.get(mutation.path);
    if (known === undefined || mutation.source.line < known) firstMutationLineByPath.set(mutation.path, mutation.source.line);
  }
  let modifiedWithoutObservedRead = 0;
  for (const [path, firstMutationLine] of firstMutationLineByPath) {
    const priorReadLines = (readLinesByPath.get(path) ?? []).filter((line) => line < firstMutationLine);
    if (priorReadLines.length > 0) continue;
    modifiedWithoutObservedRead += 1;
    findingRecords.push({
      line: firstMutationLine,
      record: {
        schemaVersion: 1,
        kind: "finding-file-modified-without-observed-read",
        confidence: "inferred",
        finding: "file-modified-without-observed-read",
        label: "a file was mutated before any successful read of that path in this session",
        path,
        firstMutationLine,
        unconfirmedReadRequests: unconfirmedReadRequestsByPath.get(path) ?? 0,
        limit: "absence of a read in this session does not prove the agent had no prior knowledge of the file",
        evidence: { artifact: "file-mutations.jsonl", path },
      },
    });
  }

  let testsNotRunAfterFinalMutation = 0;
  if (confirmedMutations.length > 0) {
    const finalMutation = confirmedMutations.reduce((latest, mutation) => (mutation.source.line > latest.source.line ? mutation : latest), confirmedMutations[0]!);
    const lastTest = tests.length > 0
      ? tests.reduce((latest, test) => (test.source.line > latest.source.line ? test : latest), tests[0]!)
      : undefined;
    if (lastTest === undefined || lastTest.source.line < finalMutation.source.line) {
      testsNotRunAfterFinalMutation += 1;
      findingRecords.push({
        line: finalMutation.source.line,
        record: {
          schemaVersion: 1,
          kind: "finding-tests-not-run-after-final-mutation",
          confidence: "inferred",
          finding: "tests-not-run-after-final-mutation",
          label: "no test command was observed after the final file mutation in this session",
          finalMutationPath: finalMutation.path,
          finalMutationLine: finalMutation.source.line,
          testsSeen: lastTest !== undefined,
          ...(lastTest === undefined
            ? {}
            : { lastTestCommand: lastTest.command, lastTestLine: lastTest.source.line }),
          limit: "a missing or earlier test run does not prove the final state is broken; it flags unverified final changes",
          evidence: { artifact: lastTest === undefined ? "file-mutations.jsonl" : "tests.jsonl", path: finalMutation.path },
        },
      });
    }
  }

  // Conservative retry matching: a failed command is unresolved only when no
  // later run of the exact same command text succeeded. Exact text matching
  // prevents claiming that a modified command retried the failure.
  const successByCommand = new Map<string, CommandArtifact[]>();
  for (const command of commands) {
    if (command.result === null || command.result.isError) continue;
    const key = command.command.trim();
    const bucket = successByCommand.get(key) ?? [];
    bucket.push(command);
    successByCommand.set(key, bucket);
  }
  const failuresByCommand = new Map<string, CommandArtifact[]>();
  for (const command of commands) {
    if (command.result === null || !command.result.isError) continue;
    const key = command.command.trim();
    const bucket = failuresByCommand.get(key) ?? [];
    bucket.push(command);
    failuresByCommand.set(key, bucket);
  }

  let unresolvedCommandFailures = 0;
  let resolvedRetries = 0;
  for (const [key, failures] of failuresByCommand) {
    const successes = successByCommand.get(key) ?? [];
    const lastFailure = failures.reduce((latest, failure) => (failure.source.line > latest.source.line ? failure : latest), failures[0]!);
    const lastSuccess = successes.length === 0 ? undefined : successes.reduce((latest, success) => (success.source.line > latest.source.line ? success : latest), successes[0]!);
    if (lastSuccess !== undefined && lastSuccess.source.line > lastFailure.source.line) {
      resolvedRetries += 1;
      continue;
    }
    unresolvedCommandFailures += 1;
    findingRecords.push({
      line: lastFailure.source.line,
      record: {
        schemaVersion: 1,
        kind: "finding-unresolved-command-failure",
        confidence: "inferred",
        finding: "unresolved-command-failure",
        label: "a command failed and no later run of the same command in this session succeeded",
        command: lastFailure.command,
        commandHash: createHash("sha256").update(lastFailure.command).digest("hex"),
        commandPreview: lastFailure.commandPreview,
        failedAttempts: failures.length,
        firstFailureLine: failures.reduce((earliest, failure) => Math.min(earliest, failure.source.line), failures[0]!.source.line),
        lastFailureLine: lastFailure.source.line,
        lastFailureToolCallId: lastFailure.toolCallId,
        limit: "exact-text retry matching cannot recognize a retry that modified the command",
        evidence: { artifact: "commands.jsonl", toolCallId: lastFailure.toolCallId },
      },
    });
  }

  ordered.sort((left, right) => left.line - right.line);
  const allEvents = [...ordered, ...findingRecords].map((entry) => entry.record);

  const eventsDirectory = join(snapshotInfo.path, "events");
  await mkdir(eventsDirectory, { recursive: true, mode: 0o700 });
  await writeAtomic(join(eventsDirectory, "deterministic.jsonl"), `${allEvents.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const findings = {
    modifiedWithoutObservedRead,
    testsNotRunAfterFinalMutation,
    unresolvedCommandFailures,
    resolvedRetries,
  };
  const derived = {
    schemaVersion: 1,
    extractor: { name: EVENT_EXTRACTOR, version: EVENT_EXTRACTOR_VERSION },
    sourceHash: snapshotInfo.sourceHash,
    status: "complete",
    counts: {
      commands: commands.length,
      commandSucceeded,
      commandFailed,
      commandsWithoutOutcome,
      fileReads: fileReads.length,
      fileMutations: fileMutations.length,
      findings: findingRecords.length,
    },
    findings,
    diagnostics,
  };
  await writeAtomic(join(snapshotInfo.path, "derived-events.json"), `${JSON.stringify(derived, null, 2)}\n`);

  return {
    schemaVersion: 1,
    kind: "events",
    extractor: { name: EVENT_EXTRACTOR, version: EVENT_EXTRACTOR_VERSION },
    store,
    sessionId: snapshotInfo.sessionId,
    sourceHash: snapshotInfo.sourceHash,
    snapshot: snapshotInfo.path,
    status: "complete",
    counts: {
      commands: commands.length,
      commandSucceeded,
      commandFailed,
      commandsWithoutOutcome,
      fileReads: fileReads.length,
      fileMutations: fileMutations.length,
      findings: findingRecords.length,
    },
    findings,
    diagnostics,
  };
}
