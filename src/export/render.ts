import { isObject } from "../pi/read-jsonl.js";

export interface EvidenceRecord {
  id: string;
  kind: string;
  sessionId: string;
  sequence: number;
  observedAt: string;
  confidence: string;
  provenance: {
    adapter?: string;
    source?: string;
    eventId?: string;
    inputLine?: number;
  };
  data: unknown;
}

function requiredString(value: Record<string, unknown>, field: string, line: number): string {
  if (typeof value[field] !== "string" || value[field].length === 0) throw new Error(`Evidence input line ${line}: ${field} must be a non-empty string`);
  return value[field];
}

export function parseEvidenceJsonl(text: string): EvidenceRecord[] {
  const records: EvidenceRecord[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Evidence input line ${index + 1}: invalid JSON: ${reason}`);
    }
    if (!isObject(value)) throw new Error(`Evidence input line ${index + 1}: must be a JSON object`);
    if (typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence)) {
      throw new Error(`Evidence input line ${index + 1}: sequence must be a safe integer`);
    }
    if (!isObject(value.provenance)) throw new Error(`Evidence input line ${index + 1}: provenance must be an object`);
    if (!("data" in value)) throw new Error(`Evidence input line ${index + 1}: data is required`);
    records.push({
      id: requiredString(value, "id", index + 1),
      kind: requiredString(value, "kind", index + 1),
      sessionId: requiredString(value, "sessionId", index + 1),
      sequence: value.sequence,
      observedAt: requiredString(value, "observedAt", index + 1),
      confidence: requiredString(value, "confidence", index + 1),
      provenance: value.provenance,
      data: value.data,
    });
  }
  return records;
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter(isObject)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
  return text.length > 0 ? text : undefined;
}

function oneLine(value: unknown): string {
  return JSON.stringify(value).replace(/\s+/g, " ");
}

function markdownText(value: string): string {
  return value.replace(/```/g, "``\\`");
}

function messageDetails(message: Record<string, unknown>): string {
  const role = typeof message.role === "string" ? message.role : "unknown";
  const text = textFromContent(message.content);
  if (text) return `**${role}**\n\n${markdownText(text)}`;
  if (Array.isArray(message.content)) {
    const calls = message.content.filter(isObject).filter((block) => block.type === "toolCall");
    if (calls.length > 0) {
      const callLines = calls.map((call) => `- \`${typeof call.name === "string" ? call.name : "unknown"}\`: ${oneLine(call.arguments)}`);
      return `**${role} tool calls**\n\n${callLines.join("\n")}`;
    }
    if (message.content.some((block) => isObject(block) && block.type === "thinking")) {
      return `**${role}**\n\n[No displayable text. The source contained thinking content.]`;
    }
  }
  return `**${role}**\n\n\`content\`: ${oneLine(message.content)}`;
}

function markdownDetails(record: EvidenceRecord): string {
  if (!isObject(record.data)) return `\`data\`: ${oneLine(record.data)}`;
  if (record.kind === "message.finalized" && isObject(record.data.message)) {
    return messageDetails(record.data.message);
  }
  if (record.kind === "tool.started") {
    return `**${typeof record.data.toolName === "string" ? record.data.toolName : "unknown tool"}**\n\n\`args\`: ${oneLine(record.data.args)}`;
  }
  if (record.kind === "tool.finished") {
    const result = isObject(record.data.result) ? textFromContent(record.data.result.content) : undefined;
    const status = record.data.isError === true ? "failed" : "finished";
    return result ? `**${status}**\n\n${markdownText(result)}` : `**${status}**\n\n\`data\`: ${oneLine(record.data)}`;
  }
  return `\`data\`: ${oneLine(record.data)}`;
}

export function evidenceToMarkdown(records: EvidenceRecord[]): string {
  const sessionIds = [...new Set(records.map((record) => record.sessionId))];
  const sources = [...new Set(records.map((record) => record.provenance.source).filter((source): source is string => source !== undefined))];
  const lines = [
    "# dvdst evidence export",
    "",
    `- Sessions: ${sessionIds.join(", ") || "none"}`,
    `- Sources: ${sources.join(", ") || "unknown"}`,
    `- Events: ${records.length}`,
    "",
    "## Timeline",
    "",
  ];
  for (const record of records) {
    lines.push(`### ${record.sequence}. ${record.kind}`, "", `- Observed: ${record.observedAt}`, `- Evidence ID: \`${record.id}\``, `- Confidence: ${record.confidence}`, "", markdownDetails(record), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function csvCell(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export function evidenceToCsv(records: EvidenceRecord[]): string {
  const header = ["id", "sessionId", "sequence", "observedAt", "kind", "confidence", "adapter", "source", "eventId", "inputLine", "data"];
  const rows = records.map((record) => [
    record.id, record.sessionId, record.sequence, record.observedAt, record.kind, record.confidence,
    record.provenance.adapter ?? "", record.provenance.source ?? "", record.provenance.eventId ?? "", record.provenance.inputLine ?? "", record.data,
  ].map(csvCell).join(","));
  return `${header.join(",")}\n${rows.join("\n")}${rows.length > 0 ? "\n" : ""}`;
}
