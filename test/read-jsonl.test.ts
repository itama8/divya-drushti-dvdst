import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { readJsonl } from "../src/pi/read-jsonl.js";

const fixturePath = fileURLToPath(new URL("./fixtures/skill-session.jsonl", import.meta.url));

describe("readJsonl", () => {
  it("records exact line and byte boundaries", async () => {
    const records = await readJsonl(fixturePath);
    assert.equal(records.length, 8);
    assert.equal(records[0]?.source.line, 1);
    assert.equal(records[0]?.source.byteStart, 0);
    assert.equal(records[0]?.source.byteEnd, 114);
    assert.equal(records[1]?.source.line, 2);
    assert.ok((records.at(-1)?.source.byteEnd ?? 0) > records[1]!.source.byteEnd);
  });
});
