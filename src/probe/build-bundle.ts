import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { classifyCommand } from "../pi/classify-commands.js";
import { extractCommitCandidates, extractCreatedCommits } from "../pi/extract-commits.js";
import { loadProjectConfig } from "../config/config.js";
import { normalizeSessionPath } from "../pi/normalize-paths.js";
import { parseDevlogFrontmatter } from "../pi/parse-devlog.js";
import { isObject, type SourceRecord, type SourceReference } from "../pi/read-jsonl.js";
import { readSessionRecords } from "../sources/read-session.js";
import { parseSkillBlock, skillNameFromContent } from "../pi/skill-block.js";

type JsonObject = Record<string, unknown>;

interface ToolCallRecord {
  id: string;
  name: string;
  arguments: JsonObject;
  turn: number;
  assistantEntryId: string;
  source: SourceReference;
}

interface MessageRecord {
  entryId: string;
  role: string;
  message: JsonObject;
  turn: number;
  source: SourceReference;
}

interface ToolResultRecord {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  text: string;
  message: MessageRecord;
}

interface SkillSeed {
  id: string;
  name: string;
  path: string;
  mode: "explicit-command" | "model-load-candidate";
  confidence: "observed" | "reconstructed";
  contentHash: string;
  contentBytes: number;
  trigger: SourceReference;
  loadResult?: SourceReference;
  turn: number;
  activeStartLine: number | undefined;
  activeEndLine: number;
}

export interface BuildBundleOptions {
  sessionPath: string;
  devlogPath?: string;
}

export interface ProbeBundle {
  schemaVersion: string;
  session: JsonObject;
  counts: JsonObject;
  goals: JsonObject[];
  files: JsonObject[];
  commands: JsonObject[];
  commitCandidates: string[];
  /** Commits the session created, read from `git commit` output. */
  commitsCreated: string[];
  skills: { invocations: SkillSeed[]; attributedRecords: JsonObject[] };
  devlogComparison?: JsonObject;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isObject)
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
}

function preview(text: string, limit = 500): string {
  const normalized = text.trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}…`;
}

function messageEntry(record: SourceRecord): JsonObject | undefined {
  if (!isObject(record.value) || record.value.type !== "message" || !isObject(record.value.message)) return undefined;
  return record.value;
}

function intersection<T>(left: T[], right: T[]): T[] {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item));
}

export async function buildProbeBundle(options: BuildBundleOptions): Promise<ProbeBundle> {
  const [{ records }, sessionStat] = await Promise.all([readSessionRecords(options.sessionPath), stat(options.sessionPath)]);
  const headerRecord = records.find((record) => isObject(record.value) && record.value.type === "session");
  if (!headerRecord || !isObject(headerRecord.value) || typeof headerRecord.value.id !== "string") {
    throw new Error("The session has no valid Pi session header");
  }
  const sessionHeader = headerRecord.value;
  const config = await loadProjectConfig({ cwd: typeof sessionHeader.cwd === "string" ? sessionHeader.cwd : undefined });

  const messages: MessageRecord[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const results = new Map<string, ToolResultRecord>();
  let turn = -1;

  for (const record of records) {
    const entry = messageEntry(record);
    if (!entry || !isObject(entry.message) || typeof entry.id !== "string") continue;
    const role = typeof entry.message.role === "string" ? entry.message.role : "unknown";
    if (role === "user") turn += 1;
    const message: MessageRecord = {
      entryId: entry.id,
      role,
      message: entry.message,
      turn,
      source: record.source,
    };
    messages.push(message);

    if (role === "assistant" && Array.isArray(entry.message.content)) {
      for (const block of entry.message.content) {
        if (!isObject(block) || block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: isObject(block.arguments) ? block.arguments : {},
          turn,
          assistantEntryId: entry.id,
          source: record.source,
        });
      }
    }

    if (role === "toolResult" && typeof entry.message.toolCallId === "string") {
      results.set(entry.message.toolCallId, {
        toolCallId: entry.message.toolCallId,
        toolName: typeof entry.message.toolName === "string" ? entry.message.toolName : "unknown",
        isError: entry.message.isError === true,
        text: textContent(entry.message.content),
        message,
      });
    }
  }

  const lastLineByTurn = new Map<number, number>();
  for (const message of messages) lastLineByTurn.set(message.turn, message.source.line);

  const skillSeeds: SkillSeed[] = [];
  const goals: JsonObject[] = [];

  for (const message of messages.filter((item) => item.role === "user")) {
    const text = textContent(message.message.content);
    const skill = parseSkillBlock(text);
    if (skill) {
      const id = `skill:${sessionHeader.id}:${message.entryId}`;
      skillSeeds.push({
        id,
        name: skill.name,
        path: skill.path,
        mode: "explicit-command",
        confidence: "observed",
        contentHash: sha256(skill.body),
        contentBytes: Buffer.byteLength(skill.body),
        trigger: message.source,
        turn: message.turn,
        activeStartLine: messages.find((item) => item.turn === message.turn && item.source.line > message.source.line && item.role === "assistant")?.source.line,
        activeEndLine: lastLineByTurn.get(message.turn) ?? message.source.line,
      });
      if (skill.userMessage) {
        goals.push({ text: preview(skill.userMessage), textBytes: Buffer.byteLength(skill.userMessage), source: message.source });
      }
    } else if (text.trim()) {
      goals.push({ text: preview(text), textBytes: Buffer.byteLength(text), source: message.source });
    }
  }

  for (const call of toolCalls) {
    const path = typeof call.arguments.path === "string" ? call.arguments.path : undefined;
    if (call.name !== "read" || !path?.endsWith("/SKILL.md")) continue;
    const result = results.get(call.id);
    if (!result || result.isError) continue;
    const nextAssistant = messages.find((item) => item.turn === call.turn && item.role === "assistant" && item.source.line > result.message.source.line);
    skillSeeds.push({
      id: `skill:${sessionHeader.id}:${sha256(call.id).slice(0, 16)}`,
      name: skillNameFromContent(result.text, path),
      path,
      mode: "model-load-candidate",
      confidence: "reconstructed",
      contentHash: sha256(result.text),
      contentBytes: Buffer.byteLength(result.text),
      trigger: call.source,
      loadResult: result.message.source,
      turn: call.turn,
      activeStartLine: nextAssistant?.source.line,
      activeEndLine: lastLineByTurn.get(call.turn) ?? result.message.source.line,
    });
  }

  const skillAttributions: JsonObject[] = [];
  for (const skill of skillSeeds) {
    if (skill.mode === "explicit-command") {
      skillAttributions.push({ invocationId: skill.id, recordKind: "message", recordId: skill.trigger.entryId, basis: "explicit-skill-message", source: skill.trigger });
    } else {
      const callId = toolCalls.find((call) => call.source.line === skill.trigger.line && call.name === "read" && call.arguments.path === skill.path)?.id;
      skillAttributions.push({ invocationId: skill.id, recordKind: "tool-call", recordId: callId, basis: "skill-load", source: skill.trigger });
    }
    if (skill.activeStartLine === undefined) continue;
    for (const message of messages) {
      if (message.turn !== skill.turn || message.source.line < skill.activeStartLine || message.source.line > skill.activeEndLine) continue;
      skillAttributions.push({ invocationId: skill.id, recordKind: "message", recordId: message.entryId, role: message.role, basis: "within-turn-window", source: message.source });
      if (message.role !== "assistant") continue;
      for (const call of toolCalls.filter((item) => item.assistantEntryId === message.entryId)) {
        skillAttributions.push({ invocationId: skill.id, recordKind: "tool-call", recordId: call.id, toolName: call.name, basis: "within-turn-window", source: call.source });
      }
    }
  }

  const attributedRecordMap = new Map<string, JsonObject & { labels: JsonObject[] }>();
  for (const attribution of skillAttributions) {
    const key = `${String(attribution.recordKind)}:${String(attribution.recordId)}`;
    const label = { invocationId: attribution.invocationId, basis: attribution.basis };
    const existing = attributedRecordMap.get(key);
    if (existing) {
      existing.labels.push(label);
    } else {
      const { invocationId: _invocationId, basis: _basis, ...record } = attribution;
      attributedRecordMap.set(key, { ...record, labels: [label] });
    }
  }
  const attributedRecords = [...attributedRecordMap.values()];

  const fileOperations = toolCalls.flatMap((call) => {
    const sourcePath = typeof call.arguments.path === "string" ? call.arguments.path : undefined;
    if (!sourcePath || !["read", "edit", "write"].includes(call.name)) return [];
    return [{
      path: normalizeSessionPath(sourcePath, sessionHeader.cwd),
      sourcePath,
      operation: call.name,
      succeeded: results.get(call.id)?.isError === false,
      toolCallId: call.id,
      source: call.source,
    }];
  });

  const fileSummary = [...new Set(fileOperations.map((item) => item.path))].sort().map((path) => {
    const operations = fileOperations.filter((item) => item.path === path);
    return {
      path,
      operations: [...new Set(operations.map((item) => item.operation))],
      count: operations.length,
      firstSource: operations[0]?.source,
      lastSource: operations.at(-1)?.source,
    };
  });

  const commands = toolCalls.filter((call) => call.name === "bash").map((call): JsonObject => {
    const command = typeof call.arguments.command === "string" ? call.arguments.command : "";
    const result = results.get(call.id);
    return {
      toolCallId: call.id,
      command,
      commandPreview: preview(command),
      commandBytes: Buffer.byteLength(command),
      commandHash: sha256(command),
      classes: classifyCommand(command, config.commandClasses),
      result: result ? {
        isError: result.isError,
        textBytes: Buffer.byteLength(result.text),
        preview: preview(result.text, 300),
        source: result.message.source,
      } : undefined,
      source: call.source,
    };
  });

  const commitCandidates = [...new Set(
    toolCalls
      .filter((call) => call.name === "bash")
      .flatMap((call) => extractCommitCandidates(results.get(call.id)?.text ?? "")),
  )];

  const commitsCreated = [...new Set(
    toolCalls
      .filter((call) => call.name === "bash" && results.get(call.id)?.isError === false)
      .flatMap((call) => extractCreatedCommits(results.get(call.id)?.text ?? "")),
  )];

  const mutatedPaths = fileSummary.filter((file) => file.operations.some((operation) => operation === "edit" || operation === "write")).map((file) => file.path);

  let devlogComparison: JsonObject | undefined;
  if (options.devlogPath) {
    const markdown = await readFile(options.devlogPath, "utf8");
    const expected = parseDevlogFrontmatter(markdown);
    devlogComparison = {
      path: options.devlogPath,
      expected: { status: expected.status, contractsTouched: expected.contractsTouched, commits: expected.commits, nextFiles: expected.nextFiles },
      observed: { mutatedPaths, commitCandidates },
      contractsTouched: {
        matched: intersection(expected.contractsTouched, mutatedPaths),
        missingFromObservedMutations: expected.contractsTouched.filter((path) => !mutatedPaths.includes(path)),
        additionalObservedMutations: mutatedPaths.filter((path) => !expected.contractsTouched.includes(path)),
      },
      commits: {
        matched: intersection(expected.commits, commitCandidates),
        missingFromCandidates: expected.commits.filter((commit) => !commitCandidates.includes(commit)),
      },
    };
  }

  return {
    schemaVersion: "0.1.0-probe",
    session: {
      id: sessionHeader.id,
      version: sessionHeader.version,
      cwd: sessionHeader.cwd,
      timestamp: sessionHeader.timestamp,
      sourcePath: options.sessionPath,
      sourceBytes: sessionStat.size,
      sourceLines: records.at(-1)?.source.line ?? 0,
    },
    counts: {
      messages: messages.length,
      toolCalls: toolCalls.length,
      toolResults: results.size,
      goals: goals.length,
      files: fileSummary.length,
      commands: commands.length,
      skillInvocations: skillSeeds.length,
      skillAttributionMemberships: skillAttributions.length,
      skillAttributedRecords: attributedRecords.length,
    },
    goals,
    files: fileSummary,
    commands,
    commitCandidates,
    commitsCreated,
    skills: { invocations: skillSeeds, attributedRecords },
    ...(devlogComparison ? { devlogComparison } : {}),
  };
}
