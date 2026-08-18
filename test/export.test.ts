import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evidenceToCsv, evidenceToMarkdown, parseEvidenceJsonl } from "../src/export/render.js";

const evidence = `{"schemaVersion":1,"id":"live:pi:s:0","kind":"message.finalized","sessionId":"s","sequence":0,"observedAt":"2026-03-13T10:00:00.000Z","confidence":"observed","provenance":{"adapter":"live","source":"pi.extension","eventId":"e0","inputLine":1},"data":{"message":{"role":"user","content":[{"type":"text","text":"Fix CSV output"}]}}}
{"schemaVersion":1,"id":"live:pi:s:1","kind":"tool.finished","sessionId":"s","sequence":1,"observedAt":"2026-03-13T10:00:01.000Z","confidence":"observed","provenance":{"adapter":"live","source":"pi.extension","eventId":"e1","inputLine":2},"data":{"toolName":"bash","isError":false,"result":{"content":[{"type":"text","text":"tests pass\\n"}]}}}
`;

describe("evidence export", () => {
  it("renders a readable Markdown timeline without inventing a summary", () => {
    const markdown = evidenceToMarkdown(parseEvidenceJsonl(evidence));
    assert.match(markdown, /# dvdst evidence export/);
    assert.match(markdown, /### 0\. message\.finalized/);
    assert.match(markdown, /\*\*user\*\*[\s\S]*Fix CSV output/);
    assert.match(markdown, /\*\*finished\*\*[\s\S]*tests pass/);
    assert.match(markdown, /Evidence ID: `live:pi:s:1`/);
  });

  it("renders quoted CSV rows with source provenance and JSON data", () => {
    const csv = evidenceToCsv(parseEvidenceJsonl(evidence));
    assert.match(csv, /^id,sessionId,sequence,observedAt,kind,/);
    assert.match(csv, /"pi\.extension"/);
    assert.match(csv, /"{\""message\"":/);
  });

  it("rejects incomplete evidence records", () => {
    assert.throws(() => parseEvidenceJsonl('{"id":"missing fields"}\n'), /Evidence input line 1/);
  });
});
