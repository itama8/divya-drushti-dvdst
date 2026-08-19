import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isObject, type SourceReference } from "../pi/read-jsonl.js";
import { parseSkillBlock, skillNameFromContent } from "../pi/skill-block.js";
import { writeAtomic } from "../store/fs-util.js";
import { readSessionSnapshot } from "../store/read-session.js";

export const SKILL_EXTRACTOR = "pi-skills";
export const SKILL_EXTRACTOR_VERSION = 1;

export interface SkillsResult {
  schemaVersion: 1;
  kind: "skills";
  extractor: { name: string; version: number };
  store: string;
  sessionId: string;
  sourceHash: string;
  snapshot: string;
  status: "complete";
  counts: {
    invocations: number;
    explicitInvocations: number;
    modelLoadCandidates: number;
    failedOrUnconfirmedLoads: number;
    attributionMemberships: number;
    attributedRecords: number;
  };
  diagnostics: { line: number; message: string }[];
}

interface MessageRecord {
  schemaVersion: number;
  entryId: string;
  role: string;
  text: string;
  source: SourceReference;
  turn: number;
}

interface ToolInvocationRecord {
  schemaVersion: number;
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  entryId: string;
  source: SourceReference;
}

interface ToolResultRecord {
  schemaVersion: number;
  toolCallId: string;
  toolName: string;
  isError: boolean;
  text: string;
  entryId: string;
  source: SourceReference;
}

interface SkillSeed {
  id: string;
  name: string;
  path?: string;
  mode: SkillInvocationMode;
  confidence: "observed" | "reconstructed";
  loadStatus: SkillLoadStatus;
  contentHash: string;
  contentBytes: number;
  trigger: SourceReference;
  loadResult?: SourceReference;
  userMessage?: string;
  triggerCallId?: string;
  turn: number;
  activeStartLine: number | undefined;
  activeEndLine: number;
}

export type SkillInvocationMode = "explicit-command" | "model-load-candidate";
export type SkillLoadStatus = "expanded" | "loaded" | "failed" | "unconfirmed";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function preview(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
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

/**
 * Detects skill use from normalized records and attributes the records each
 * invocation may have influenced.
 *
 * records/skill-invocations.jsonl    explicit /skill:command blocks and model
 *                                    loads of SKILL.md files, with content
 *                                    hashes, load status, and line boundaries
 * records/skill-attributions.jsonl   each attributed record with a labels array
 *                                    describing every invocation it belongs to
 *
 * The extractor is deterministic and idempotent. A successful SKILL.md read is
 * an observed load and a reconstructed invocation candidate, never proof of
 * adherence. A failed or unconfirmed load stays visible with a non-active
 * status instead of disappearing. Attribution uses a conservative same-turn
 * rule: the inferred span starts at the first assistant record after the load
 * and ends at the next user message.
 */
export async function extractSkills(options: {
  store: string;
  sessionId: string;
  sourceHash?: string;
}): Promise<SkillsResult> {
  const store = resolve(options.store);
  const snapshotInfo = await readSessionSnapshot(options);
  const recordsDirectory = join(snapshotInfo.path, "records");
  const parse = async <T>(filename: string): Promise<T[]> => {
    const text = await readFile(join(recordsDirectory, filename), "utf8");
    return new JsonlRows(text, filename).parse<T>();
  };

  const rawMessages = await parse<Omit<MessageRecord, "turn">>("messages.jsonl");
  const invocations = await parse<ToolInvocationRecord>("tool-invocations.jsonl");
  const results = await parse<ToolResultRecord>("tool-results.jsonl");
  const resultByCallId = new Map(results.map((result) => [result.toolCallId, result]));

  // Reconstruct agent turns in append order: a user message starts a new turn.
  const turnByEntry = new Map<string, number>();
  const lastLineByTurn = new Map<number, number>();
  let turn = -1;
  const messages: MessageRecord[] = [];
  for (const message of rawMessages) {
    if (message.role === "user") turn += 1;
    turnByEntry.set(message.entryId, turn);
    lastLineByTurn.set(turn, message.source.line);
    messages.push({ ...message, turn });
  }

  const seeds: SkillSeed[] = [];
  const diagnostics: { line: number; message: string }[] = [];

  // 1. Explicit expanded /skill:name messages are observed invocations.
  for (const message of messages) {
    if (message.role !== "user") continue;
    const skill = parseSkillBlock(message.text);
    if (!skill) continue;
    const id = `skill:${snapshotInfo.sessionId}:${message.entryId}`;
    seeds.push({
      id,
      name: skill.name,
      path: skill.path,
      mode: "explicit-command",
      confidence: "observed",
      loadStatus: "expanded",
      contentHash: sha256(skill.body),
      contentBytes: Buffer.byteLength(skill.body),
      trigger: message.source,
      turn: message.turn,
      ...(skill.userMessage === undefined ? {} : { userMessage: skill.userMessage }),
      activeStartLine: messages.find((item) => item.turn === message.turn && item.source.line > message.source.line && item.role === "assistant")?.source.line,
      activeEndLine: lastLineByTurn.get(message.turn) ?? message.source.line,
    });
  }

  // 2. A successful read of a SKILL.md file is an observed load and a
  //    reconstructed invocation candidate. Failed or unconfirmed reads stay
  //    visible as non-active load attempts.
  for (const call of invocations) {
    if (call.name !== "read") continue;
    const path = typeof call.arguments.path === "string" ? call.arguments.path : undefined;
    if (path === undefined || !(/SKILL\.md$/.test(path))) continue;
    const result = resultByCallId.get(call.toolCallId);
    const entryTurn = turnByEntry.get(call.entryId) ?? -1;
    const loaded = result !== undefined && !result.isError;
    const loadStatus: SkillLoadStatus = result === undefined ? "unconfirmed" : result.isError ? "failed" : "loaded";
    const baseLine = result === undefined ? call.source.line : result.source.line;
    const nextAssistant = messages.find((item) => item.turn === entryTurn && item.role === "assistant" && item.source.line > baseLine);
    seeds.push({
      id: `skill:${snapshotInfo.sessionId}:${sha256(call.toolCallId).slice(0, 16)}`,
      name: loaded ? skillNameFromContent(result.text, path) : path,
      path,
      mode: "model-load-candidate",
      confidence: "reconstructed",
      loadStatus,
      contentHash: loaded ? sha256(result.text) : "",
      contentBytes: loaded ? Buffer.byteLength(result.text) : 0,
      trigger: call.source,
      ...(result === undefined ? {} : { loadResult: result.source }),
      triggerCallId: call.toolCallId,
      turn: entryTurn,
      activeStartLine: loaded ? nextAssistant?.source.line : undefined,
      activeEndLine: lastLineByTurn.get(entryTurn) ?? baseLine,
    });
  }

  // 3. Attribute records to each invocation with a conservative same-turn
  //    boundary. Overlapping invocations keep separate labels.
  const attributions: Array<Record<string, unknown>> = [];
  const nonActiveSeeds = new Set<string>();
  for (const seed of seeds) {
    if (seed.loadStatus === "failed" || seed.loadStatus === "unconfirmed") nonActiveSeeds.add(seed.id);
  }
  for (const seed of seeds) {
    const nonActive = nonActiveSeeds.has(seed.id);
    if (seed.mode === "explicit-command") {
      attributions.push({ invocationId: seed.id, recordKind: "message", recordId: seed.trigger.entryId, role: "user", basis: "explicit-skill-message", source: seed.trigger });
    } else if (seed.triggerCallId !== undefined) {
      attributions.push({ invocationId: seed.id, recordKind: "tool-call", recordId: seed.triggerCallId, toolName: "read", basis: "skill-load", source: seed.trigger });
    }
    if (nonActive || seed.activeStartLine === undefined) continue;
    for (const message of messages) {
      if (message.turn !== seed.turn || message.source.line < seed.activeStartLine || message.source.line > seed.activeEndLine) continue;
      attributions.push({ invocationId: seed.id, recordKind: "message", recordId: message.entryId, role: message.role, basis: "within-turn-window", source: message.source });
      if (message.role !== "assistant") continue;
      for (const call of invocations) {
        if (call.entryId !== message.entryId) continue;
        attributions.push({ invocationId: seed.id, recordKind: "tool-call", recordId: call.toolCallId, toolName: call.name, basis: "within-turn-window", source: call.source });
      }
    }
  }

  const attributedRecordMap = new Map<string, Record<string, unknown> & { labels: Array<Record<string, unknown>> }>();
  for (const attribution of attributions) {
    const key = `${String(attribution.recordKind)}:${String(attribution.recordId)}`;
    const label = { invocationId: attribution.invocationId, basis: attribution.basis };
    const existing = attributedRecordMap.get(key);
    if (existing) {
      existing.labels.push(label);
      continue;
    }
    const { invocationId: _invocationId, basis: _basis, ...record } = attribution;
    attributedRecordMap.set(key, { ...record, labels: [label] });
  }
  const attributedRecords = [...attributedRecordMap.values()];

  const invocationLines = seeds.map((seed) => ({
    schemaVersion: 1 as const,
    kind: "skill-invocation" as const,
    id: seed.id,
    name: seed.name,
    ...(seed.path === undefined ? {} : { path: seed.path }),
    mode: seed.mode,
    confidence: seed.confidence,
    loadStatus: seed.loadStatus,
    contentHash: seed.contentHash,
    contentBytes: seed.contentBytes,
    turn: seed.turn,
    trigger: seed.trigger,
    ...(seed.loadResult === undefined ? {} : { loadResult: seed.loadResult }),
    ...(seed.userMessage === undefined ? {} : { userMessage: preview(seed.userMessage, 300) }),
    ...(seed.activeStartLine === undefined ? { activeStartLine: null } : { activeStartLine: seed.activeStartLine }),
    activeEndLine: seed.activeEndLine,
    boundaryRule: seed.mode === "explicit-command" ? "explicit-command" : "same-agent-turn",
  }));

  const summary = {
    invocations: seeds.length,
    explicitInvocations: seeds.filter((seed) => seed.mode === "explicit-command").length,
    modelLoadCandidates: seeds.filter((seed) => seed.mode === "model-load-candidate").length,
    failedOrUnconfirmedLoads: [...nonActiveSeeds].length,
    attributionMemberships: attributions.length,
    attributedRecords: attributedRecords.length,
  };

  await mkdir(recordsDirectory, { recursive: true, mode: 0o700 });
  await writeAtomic(join(recordsDirectory, "skill-invocations.jsonl"), `${invocationLines.map((row) => JSON.stringify(row)).join("\n")}\n`);
  await writeAtomic(join(recordsDirectory, "skill-attributions.jsonl"), `${attributedRecords.map((row) => JSON.stringify({ schemaVersion: 1, kind: "skill-attribution", ...row })).join("\n")}\n`);

  const derived = {
    schemaVersion: 1,
    extractor: { name: SKILL_EXTRACTOR, version: SKILL_EXTRACTOR_VERSION },
    sourceHash: snapshotInfo.sourceHash,
    status: "complete",
    counts: summary,
    diagnostics,
  };
  await writeAtomic(join(snapshotInfo.path, "derived-skills.json"), `${JSON.stringify(derived, null, 2)}\n`);

  return {
    schemaVersion: 1,
    kind: "skills",
    extractor: { name: SKILL_EXTRACTOR, version: SKILL_EXTRACTOR_VERSION },
    store,
    sessionId: snapshotInfo.sessionId,
    sourceHash: snapshotInfo.sourceHash,
    snapshot: snapshotInfo.path,
    status: "complete",
    counts: summary,
    diagnostics,
  };
}
