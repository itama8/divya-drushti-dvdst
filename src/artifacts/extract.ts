import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { COMMAND_CLASSIFIER_VERSION, classifyCommandWithReasons } from "../pi/classify-commands.js";
import { isObject, type SourceReference } from "../pi/read-jsonl.js";
import { exists, writeAtomic } from "../store/fs-util.js";
import { readSessionSnapshot } from "../store/read-session.js";

export const ARTIFACT_EXTRACTOR = "pi-artifacts";
export const ARTIFACT_EXTRACTOR_VERSION = 1;
export const BLOB_THRESHOLD_BYTES = 64 * 1024;

export interface ArtifactsResult {
  schemaVersion: 1;
  kind: "artifacts";
  extractor: { name: string; version: number };
  store: string;
  sessionId: string;
  sourceHash: string;
  snapshot: string;
  status: "complete";
  counts: {
    fileReads: number;
    fileMutations: number;
    searches: number;
    commands: number;
    tests: number;
    unknownTools: number;
    missingResults: number;
    blobs: number;
  };
  diagnostics: { line: number; message: string }[];
}

interface ToolInvocationRecord {
  schemaVersion: number;
  toolCallId: string;
  name: string;
  arguments: unknown;
  entryId: string;
  source: SourceReference;
}

interface ToolResultRecord {
  schemaVersion: number;
  toolCallId: string;
  toolName: string;
  isError: boolean;
  text: string;
  blobBlocks: Array<{ blob: string; bytes: number }>;
  entryId: string;
  source: SourceReference;
}

interface BlobWriter {
  write(data: Buffer): Promise<string>;
  known: Set<string>;
}

function parseJsonl<T>(text: string, filename: string): T[] {
  const rows: T[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${filename} line ${index + 1}: invalid JSON: ${reason}`);
    }
  }
  return rows;
}

function makeBlobWriter(directory: string): BlobWriter {
  const known = new Set<string>();
  return {
    known,
    async write(data) {
      const hash = createHash("sha256").update(data).digest("hex");
      if (!known.has(hash)) {
        const target = join(directory, hash.slice(0, 2), hash);
        if (!(await exists(target))) {
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, data, { mode: 0o600 });
        }
        known.add(hash);
      }
      return hash;
    },
  };
}

function stringField(value: Record<string, unknown>, name: string): string | undefined {
  return typeof value[name] === "string" ? value[name] : undefined;
}

function numericField(value: Record<string, unknown>, name: string): number | undefined {
  return typeof value[name] === "number" ? value[name] : undefined;
}

function resultPayload(result: ToolResultRecord | undefined): { outputBytes: number; blobs: Array<{ blob: string; bytes: number }> } {
  const blobs = result?.blobBlocks ?? [];
  const outputBytes = (result === undefined ? 0 : Buffer.byteLength(result.text)) + blobs.reduce((sum, blob) => sum + blob.bytes, 0);
  return { outputBytes, blobs };
}

interface EditOperation {
  oldText?: string | { blob: string; bytes: number };
  newText?: string | { blob: string; bytes: number };
  observed: boolean;
}

async function blobOrText(text: string, writer: BlobWriter): Promise<{ value: string | { blob: string; bytes: number }; bytes: number }> {
  const bytes = Buffer.byteLength(text);
  if (bytes < BLOB_THRESHOLD_BYTES) return { value: text, bytes };
  const blob = await writer.write(Buffer.from(text, "utf8"));
  return { value: { blob, bytes }, bytes };
}

function preview(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function unknownRecord(invocation: ToolInvocationRecord): unknown {
  return {
    schemaVersion: 1,
    kind: "unknown-tool",
    toolCallId: invocation.toolCallId,
    toolName: invocation.name,
    arguments: invocation.arguments,
    source: invocation.source,
  };
}

/**
 * Turns normalized tool records into tool-specific artifacts.
 *
 * artifacts/file-reads.jsonl        read calls with the requested range and
 *                                   the returned byte count
 * artifacts/file-mutations.jsonl    edit and write calls with their patches
 * artifacts/searches.jsonl          web and search-style tools
 * artifacts/commands.jsonl          bash calls with output and classification
 * artifacts/tests.jsonl             commands classified as tests
 * artifacts/unknown-tools.jsonl     every other tool, never dropped
 *
 * The extractor is deterministic and idempotent. Mutation records state
 * whether the patch is observed from arguments or reconstructed, and never
 * claim an exact final diff without repository before-and-after state.
 */
export async function extractArtifacts(options: {
  store: string;
  sessionId: string;
  sourceHash?: string;
}): Promise<ArtifactsResult> {
  const store = resolve(options.store);
  const snapshotInfo = await readSessionSnapshot(options);
  const recordsDirectory = join(snapshotInfo.path, "records");
  const invocations = parseJsonl<ToolInvocationRecord>(await readFile(join(recordsDirectory, "tool-invocations.jsonl"), "utf8"), "tool-invocations.jsonl");
  const results = parseJsonl<ToolResultRecord>(await readFile(join(recordsDirectory, "tool-results.jsonl"), "utf8"), "tool-results.jsonl");
  const resultByCallId = new Map(results.map((result) => [result.toolCallId, result]));
  const writer = makeBlobWriter(join(store, "blobs", "sha256"));

  const fileReads: unknown[] = [];
  const fileMutations: unknown[] = [];
  const searches: unknown[] = [];
  const commands: unknown[] = [];
  const tests: unknown[] = [];
  const unknownTools: unknown[] = [];
  const diagnostics: { line: number; message: string }[] = [];
  let missingResults = 0;

  for (const invocation of invocations) {
    const toolCallId = invocation.toolCallId;
    const result = resultByCallId.get(toolCallId);
    if (result === undefined) missingResults += 1;
    const args = isObject(invocation.arguments) ? invocation.arguments : {};
    const path = stringField(args, "path");
    const payload = resultPayload(result);

    switch (invocation.name) {
      case "read": {
        if (path === undefined) {
          unknownTools.push(unknownRecord(invocation));
          diagnostics.push({ line: invocation.source.line, message: `read call ${toolCallId} has no string path; kept as generic` });
          continue;
        }
        const offset = numericField(args, "offset");
        const limit = numericField(args, "limit");
        fileReads.push({
          schemaVersion: 1,
          kind: "file-read",
          path,
          toolCallId,
          requestedRange: {
            ...(offset === undefined ? {} : { offset }),
            ...(limit === undefined ? {} : { limit }),
          },
          returnedBytes: payload.outputBytes,
          blobs: payload.blobs,
          succeeded: result === undefined ? null : !result.isError,
          source: invocation.source,
          ...(result === undefined ? {} : { resultSource: result.source }),
        });
        break;
      }
      case "edit": {
        if (path === undefined) {
          unknownTools.push(unknownRecord(invocation));
          diagnostics.push({ line: invocation.source.line, message: `edit call ${toolCallId} has no string path; kept as generic` });
          continue;
        }
        const rawOps = Array.isArray(args.edits) ? args.edits.filter(isObject) : [];
        const editOps: EditOperation[] = [];
        for (const op of rawOps) {
          const oldText = stringField(op, "oldText");
          const newText = stringField(op, "newText");
          const oldValue = oldText === undefined ? undefined : (await blobOrText(oldText, writer)).value;
          const newValue = newText === undefined ? undefined : (await blobOrText(newText, writer)).value;
          editOps.push({
            ...(oldValue === undefined ? {} : { oldText: oldValue }),
            ...(newValue === undefined ? {} : { newText: newValue }),
            observed: oldText !== undefined && newText !== undefined,
          });
        }
        const observed = editOps.every((op) => op.observed);
        fileMutations.push({
          schemaVersion: 1,
          kind: "file-mutation",
          operation: "edit",
          path,
          toolCallId,
          edits: editOps,
          patch: {
            observed: observed || editOps.length === 0,
            exact: false,
            reason: editOps.length === 0
              ? "edit arguments carry no replacement pairs"
              : observed
                ? "edit arguments contain before and after text"
                : "edit arguments lack before or after text for some pairs",
          },
          succeeded: result === undefined ? null : !result.isError,
          source: invocation.source,
          ...(result === undefined ? {} : { resultSource: result.source }),
        });
        break;
      }
      case "write": {
        if (path === undefined) {
          unknownTools.push(unknownRecord(invocation));
          diagnostics.push({ line: invocation.source.line, message: `write call ${toolCallId} has no string path; kept as generic` });
          continue;
        }
        const content = args.content;
        let contentRef: unknown;
        let contentBytes = 0;
        if (typeof content === "string") {
          const blobbed = await blobOrText(content, writer);
          contentRef = blobbed.value;
          contentBytes = blobbed.bytes;
        } else if (isObject(content) && typeof content.blob === "string" && typeof content.bytes === "number") {
          // The normalizer already moved the body to a blob; reference it as-is.
          contentRef = { blob: content.blob, bytes: content.bytes };
          contentBytes = content.bytes;
        } else if (content !== undefined) {
          contentBytes = Buffer.byteLength(JSON.stringify(content));
          contentRef = await writer.write(Buffer.from(JSON.stringify(content), "utf8"));
        }
        fileMutations.push({
          schemaVersion: 1,
          kind: "file-mutation",
          operation: "write",
          path,
          toolCallId,
          ...(contentRef === undefined ? {} : { content: contentRef }),
          contentBytes,
          patch: {
            observed: true,
            exact: false,
            reason: "write supplies the new body but not the prior file state; exact diff unknown without repository state",
          },
          succeeded: result === undefined ? null : !result.isError,
          source: invocation.source,
          ...(result === undefined ? {} : { resultSource: result.source }),
        });
        break;
      }
      case "bash": {
        const command = stringField(args, "command");
        if (command === undefined) {
          unknownTools.push(unknownRecord(invocation));
          diagnostics.push({ line: invocation.source.line, message: `bash call ${toolCallId} has no string command; kept as generic` });
          continue;
        }
        const classifications = classifyCommandWithReasons(command);
        const output = await blobOrText(result?.text ?? "", writer);
        const commandArtifact = {
          schemaVersion: 1,
          kind: "command",
          toolCallId,
          command,
          commandPreview: preview(command, 300),
          commandBytes: Buffer.byteLength(command),
          commandHash: createHash("sha256").update(command).digest("hex"),
          result: result === undefined
            ? null
            : {
                isError: result.isError,
                outputText: preview(result.text, 300),
                outputBytes: payload.outputBytes,
                output: output.value,
                blobs: payload.blobs,
                truncation: "unknown",
              },
          classifications: classifications.map((classification) => ({ ...classification, version: COMMAND_CLASSIFIER_VERSION })),
          source: invocation.source,
          ...(result === undefined ? {} : { resultSource: result.source }),
        };
        commands.push(commandArtifact);
        if (classifications.some((classification) => classification.name === "test")) {
          tests.push({
            schemaVersion: 1,
            kind: "test-run",
            toolCallId,
            command,
            result: commandArtifact.result,
            classifications: commandArtifact.classifications,
            source: invocation.source,
          });
        }
        break;
      }
      case "web": {
        searches.push({
          schemaVersion: 1,
          kind: "search",
          toolName: invocation.name,
          query: stringField(args, "query") ?? null,
          toolCallId,
          succeeded: result === undefined ? null : !result.isError,
          source: invocation.source,
          ...(result === undefined ? {} : { resultSource: result.source }),
        });
        break;
      }
      default:
        unknownTools.push(unknownRecord(invocation));
        break;
    }
  }

  const artifactsDirectory = join(snapshotInfo.path, "artifacts");
  await mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });
  const writeJsonl = async (filename: string, rows: unknown[]): Promise<void> => {
    const body = rows.length === 0 ? "" : `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    await writeAtomic(join(artifactsDirectory, filename), body);
  };
  await Promise.all([
    writeJsonl("file-reads.jsonl", fileReads),
    writeJsonl("file-mutations.jsonl", fileMutations),
    writeJsonl("searches.jsonl", searches),
    writeJsonl("commands.jsonl", commands),
    writeJsonl("tests.jsonl", tests),
    writeJsonl("unknown-tools.jsonl", unknownTools),
  ]);
  const derived = {
    schemaVersion: 1,
    extractor: { name: ARTIFACT_EXTRACTOR, version: ARTIFACT_EXTRACTOR_VERSION },
    sourceHash: snapshotInfo.sourceHash,
    status: "complete",
    counts: {
      fileReads: fileReads.length,
      fileMutations: fileMutations.length,
      searches: searches.length,
      commands: commands.length,
      tests: tests.length,
      unknownTools: unknownTools.length,
      missingResults,
      blobs: writer.known.size,
    },
    diagnostics,
  };
  await writeAtomic(join(snapshotInfo.path, "derived-artifacts.json"), `${JSON.stringify(derived, null, 2)}\n`);

  return {
    schemaVersion: 1,
    kind: "artifacts",
    extractor: { name: ARTIFACT_EXTRACTOR, version: ARTIFACT_EXTRACTOR_VERSION },
    store,
    sessionId: snapshotInfo.sessionId,
    sourceHash: snapshotInfo.sourceHash,
    snapshot: snapshotInfo.path,
    status: "complete",
    counts: {
      fileReads: fileReads.length,
      fileMutations: fileMutations.length,
      searches: searches.length,
      commands: commands.length,
      tests: tests.length,
      unknownTools: unknownTools.length,
      missingResults,
      blobs: writer.known.size,
    },
    diagnostics,
  };
}