import { createReadStream } from "node:fs";

export interface SourceReference {
  entryId?: string;
  line: number;
  byteStart: number;
  byteEnd: number;
}

export interface SourceRecord {
  value: unknown;
  source: SourceReference;
}

export class JsonlParseError extends Error {
  readonly source: SourceReference;

  constructor(message: string, source: SourceReference) {
    super(message);
    this.name = "JsonlParseError";
    this.source = source;
  }
}

function parseLine(buffer: Buffer, source: SourceReference): SourceRecord | undefined {
  const lineBuffer = buffer.at(-1) === 0x0d ? buffer.subarray(0, -1) : buffer;
  const text = lineBuffer.toString("utf8");
  if (text.trim().length === 0) return undefined;

  try {
    const value: unknown = JSON.parse(text);
    if (isObject(value) && typeof value.id === "string") {
      source.entryId = value.id;
    }
    return { value, source };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new JsonlParseError(`Invalid JSONL at line ${source.line}: ${reason}`, source);
  }
}

export async function readJsonl(path: string): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
  let pending = Buffer.alloc(0);
  let pendingStart = 0;
  let line = 1;

  for await (const rawChunk of createReadStream(path)) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    const combined = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let lineStart = 0;

    for (let index = 0; index < combined.length; index += 1) {
      if (combined[index] !== 0x0a) continue;
      const source = {
        line,
        byteStart: pendingStart + lineStart,
        byteEnd: pendingStart + index + 1,
      };
      const record = parseLine(combined.subarray(lineStart, index), source);
      if (record) records.push(record);
      line += 1;
      lineStart = index + 1;
    }

    pending = combined.subarray(lineStart);
    pendingStart += lineStart;
  }

  if (pending.length > 0) {
    const source = {
      line,
      byteStart: pendingStart,
      byteEnd: pendingStart + pending.length,
    };
    const record = parseLine(pending, source);
    if (record) records.push(record);
  }

  return records;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
