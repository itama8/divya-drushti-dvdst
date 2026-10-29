import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isObject, type SourceReference } from "../pi/read-jsonl.js";
import { readSessionRecords } from "../sources/read-session.js";
import { exists, writeAtomic } from "../store/fs-util.js";
import { readSessionSnapshot } from "../store/read-session.js";

export const NORMALIZE_EXTRACTOR = "pi-normalize";
export const NORMALIZE_EXTRACTOR_VERSION = 1;
/** Payloads at or above this size move to the shared blob store. */
export const BLOB_THRESHOLD_BYTES = 64 * 1024;

export interface NormalizeResult {
  schemaVersion: 1;
  kind: "normalization";
  extractor: { name: string; version: number };
  store: string;
  sessionId: string;
  sourceHash: string;
  snapshot: string;
  status: "complete";
  counts: {
    entries: number;
    messages: number;
    toolInvocations: number;
    toolResults: number;
    timeline: number;
    blobs: number;
    blobBytes: number;
  };
  orphans: { calls: number; results: number };
  diagnostics: { line: number; message: string }[];
}

interface BlobInfo {
  blob: string;
  bytes: number;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

interface BlobWriter {
  write(data: Buffer): Promise<string>;
  known: Set<string>;
  bytes(): number;
}

function makeBlobWriter(directory: string): BlobWriter {
  const known = new Set<string>();
  let total = 0;
  return {
    known,
    bytes: () => total,
    async write(data) {
      const hash = createHash("sha256").update(data).digest("hex");
      if (!known.has(hash)) {
        const target = join(directory, hash.slice(0, 2), hash);
        if (!(await exists(target))) {
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, data, { mode: 0o600 });
        }
        known.add(hash);
        total += data.length;
      }
      return hash;
    },
  };
}

/**
 * Replaces large text and content payloads with blob references. The returned
 * refs list names only the blobs created for this payload, so consumers can
 * join a message or result to its exact blobs.
 */
async function deblobContent(content: unknown, writer: BlobWriter): Promise<{ value: unknown; refs: BlobInfo[] }> {
  const refs: BlobInfo[] = [];
  if (typeof content === "string") {
    const bytes = Buffer.byteLength(content);
    if (bytes < BLOB_THRESHOLD_BYTES) return { value: content, refs };
    const blob = await writer.write(Buffer.from(content, "utf8"));
    refs.push({ blob, bytes });
    return { value: { type: "text", blob, bytes }, refs };
  }
  if (!Array.isArray(content)) return { value: content, refs };
  const blocks: unknown[] = [];
  for (const block of content) {
    if (isObject(block) && block.type === "toolCall") {
      // Keep tool calls structural at all sizes; deblob only their large
      // string arguments so the call stays queryable by id, name, and path.
      if (isObject(block.arguments)) {
        blocks.push({ ...block, arguments: await deblobArguments(block.arguments, writer) });
      } else {
        blocks.push(block);
      }
      continue;
    }
    if (isObject(block) && typeof block.text === "string") {
      const bytes = Buffer.byteLength(block.text);
      if (bytes >= BLOB_THRESHOLD_BYTES) {
        const blob = await writer.write(Buffer.from(block.text, "utf8"));
        refs.push({ blob, bytes });
        blocks.push({ type: "text", blob, bytes });
        continue;
      }
    }
    if (isObject(block) && serializedBytes(block) >= BLOB_THRESHOLD_BYTES) {
      const bytes = serializedBytes(block);
      const blob = await writer.write(Buffer.from(JSON.stringify(block), "utf8"));
      refs.push({ blob, bytes });
      blocks.push({ type: "blob", blob, bytes, sourceType: typeof block.type === "string" ? block.type : "blob" });
      continue;
    }
    blocks.push(block);
  }
  return { value: blocks, refs };
}

/**
 * Replaces large string arguments with blob references, keeping the argument
 * keys intact so consumers can still read fields such as path or command.
 */
async function deblobArguments(args: unknown, writer: BlobWriter): Promise<unknown> {
  if (!isObject(args)) return args;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && Buffer.byteLength(value) >= BLOB_THRESHOLD_BYTES) {
      const bytes = Buffer.byteLength(value);
      const blob = await writer.write(Buffer.from(value, "utf8"));
      result[key] = { blob, bytes };
    } else {
      result[key] = value;
    }
  }
  return result;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isObject)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

/**
 * Normalizes every known Pi entry type into records streams.
 *
 * entries.jsonl             one record per source entry, with parent links,
 *                           append order, provenance, and the original value
 *                           (large payloads replaced by blob references)
 * messages.jsonl            conversation view: role, readable text, blob refs
 * tool-invocations.jsonl    tool calls with their arguments
 * tool-results.jsonl        tool results keyed by tool call ID
 * timeline.jsonl            append-order index with joins into the other streams
 *
 * The extractor is deterministic and idempotent. It rewrites only the derived
 * records inside a snapshot; the raw source snapshot is never touched.
 */
export async function normalizeSnapshot(options: {
  store: string;
  sessionId: string;
  sourceHash?: string;
}): Promise<NormalizeResult> {
  const store = resolve(options.store);
  const snapshotInfo = await readSessionSnapshot(options);
  const { records: sourceRecords } = await readSessionRecords(snapshotInfo.rawPath);
  const writer = makeBlobWriter(join(store, "blobs", "sha256"));

  const entries: unknown[] = [];
  const messages: unknown[] = [];
  const invocations: unknown[] = [];
  const results: unknown[] = [];
  const timeline: unknown[] = [];
  const diagnostics: { line: number; message: string }[] = [];
  const roleByEntry = new Map<string, string>();
  let messageSequence = 0;

  for (const record of sourceRecords) {
    const value = record.value;
    const sequence = record.source.line;

    if (!isObject(value)) {
      diagnostics.push({ line: record.source.line, message: "entry is not a JSON object" });
      continue;
    }
    const type = typeof value.type === "string" ? value.type : "unknown";
    const id = typeof value.id === "string" ? value.id : `entry:${record.source.line}`;
    if (typeof value.id !== "string") {
      diagnostics.push({ line: record.source.line, message: `entry of type ${type} has no string id; used ${id}` });
    }
    const parentId = value.parentId;
    const timestamp = typeof value.timestamp === "string" ? value.timestamp : undefined;
    const normalizedValue: Record<string, unknown> = { ...value };

    if (isObject(normalizedValue.message)) {
      const message = normalizedValue.message;
      const role = typeof message.role === "string" ? message.role : "unknown";
      const deblobbed = await deblobContent(message.content, writer);
      message.content = deblobbed.value;
      const content = deblobbed.value;
      messages.push({
        schemaVersion: 1,
        entryId: id,
        role,
        text: textFromContent(content),
        hasToolCalls: Array.isArray(content) && content.some((block) => isObject(block) && block.type === "toolCall"),
        hasThinking: Array.isArray(content) && content.some((block) => isObject(block) && block.type === "thinking"),
        blobBlocks: deblobbed.refs.map((ref) => ({ ...ref })),
        source: record.source,
      });
      roleByEntry.set(id, role);
      messageSequence += 1;

      if (role === "assistant" && Array.isArray(content)) {
        for (const block of content) {
          if (!isObject(block) || block.type !== "toolCall") continue;
          if (typeof block.id !== "string" || typeof block.name !== "string") {
            diagnostics.push({ line: record.source.line, message: "tool call block lacks an id or name" });
            continue;
          }
          invocations.push({
            schemaVersion: 1,
            toolCallId: block.id,
            name: block.name,
            arguments: await deblobArguments(block.arguments, writer),
            entryId: id,
            source: record.source,
          });
        }
      }

      if (typeof message.toolCallId === "string") {
        results.push({
          schemaVersion: 1,
          toolCallId: message.toolCallId,
          toolName: typeof message.toolName === "string" ? message.toolName : "unknown",
          isError: message.isError === true,
          text: textFromContent(content),
          blobBlocks: deblobbed.refs.map((ref) => ({ ...ref })),
          entryId: id,
          source: record.source,
        });
      }
    }

    entries.push({
      schemaVersion: 1,
      id,
      type,
      ...(parentId === null ? { parentId: null } : parentId === undefined ? {} : { parentId }),
      ...(timestamp === undefined ? {} : { timestamp }),
      data: normalizedValue,
      source: record.source,
    });
    timeline.push({
      schemaVersion: 1,
      sequence,
      entryId: id,
      type,
      ...(roleByEntry.get(id) === undefined ? {} : { role: roleByEntry.get(id)! }),
    });
  }

  const orphanCalls = new Set<string>();
  const orphanResults = new Set<string>();
  const matchedResults = new Set<string>();
  for (const invocation of invocations) {
    const call = invocation as { toolCallId: string };
    const match = results.find((result) => (result as { toolCallId: string }).toolCallId === call.toolCallId);
    if (match !== undefined) {
      matchedResults.add(call.toolCallId);
    } else {
      orphanCalls.add(call.toolCallId);
      diagnostics.push({ line: (invocation as { source: SourceReference }).source.line, message: `tool call ${call.toolCallId} has no matching result` });
    }
  }
  for (const result of results) {
    const call = result as { toolCallId: string };
    if (!matchedResults.has(call.toolCallId)) {
      orphanResults.add(call.toolCallId);
      diagnostics.push({ line: (result as { source: SourceReference }).source.line, message: `tool result ${call.toolCallId} has no matching call` });
    }
  }

  const recordsDirectory = join(snapshotInfo.path, "records");
  await mkdir(recordsDirectory, { recursive: true, mode: 0o700 });
  const writeJsonl = async (filename: string, rows: unknown[]): Promise<void> => {
    const body = rows.length === 0 ? "" : `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    await writeAtomic(join(recordsDirectory, filename), body);
  };
  await Promise.all([
    writeJsonl("entries.jsonl", entries),
    writeJsonl("messages.jsonl", messages),
    writeJsonl("tool-invocations.jsonl", invocations),
    writeJsonl("tool-results.jsonl", results),
    writeJsonl("timeline.jsonl", timeline),
  ]);
  const derived = {
    schemaVersion: 1,
    extractor: { name: NORMALIZE_EXTRACTOR, version: NORMALIZE_EXTRACTOR_VERSION },
    sourceHash: snapshotInfo.sourceHash,
    status: "complete",
    counts: {
      entries: entries.length,
      messages: messages.length,
      toolInvocations: invocations.length,
      toolResults: results.length,
      timeline: timeline.length,
      blobs: writer.known.size,
      blobBytes: writer.bytes(),
    },
    orphans: {
      calls: [...orphanCalls],
      results: [...orphanResults],
    },
    diagnostics,
  };
  await writeAtomic(join(snapshotInfo.path, "derived.json"), `${JSON.stringify(derived, null, 2)}\n`);

  return {
    schemaVersion: 1,
    kind: "normalization",
    extractor: { name: NORMALIZE_EXTRACTOR, version: NORMALIZE_EXTRACTOR_VERSION },
    store,
    sessionId: snapshotInfo.sessionId,
    sourceHash: snapshotInfo.sourceHash,
    snapshot: snapshotInfo.path,
    status: "complete",
    counts: {
      entries: entries.length,
      messages: messages.length,
      toolInvocations: invocations.length,
      toolResults: results.length,
      timeline: timeline.length,
      blobs: writer.known.size,
      blobBytes: writer.bytes(),
    },
    orphans: { calls: orphanCalls.size, results: orphanResults.size },
    diagnostics,
  };
}