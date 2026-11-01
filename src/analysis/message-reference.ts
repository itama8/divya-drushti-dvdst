import { isAbsolute } from "node:path";
import { isObject } from "../pi/read-jsonl.js";

export interface MessageReference {
  v: 1;
  path: string;
  fingerprint: string;
  seq: number;
  line: number;
  id: string | null;
}

export function encodeMessageReference(reference: MessageReference): string {
  return `dvdst-message:${Buffer.from(JSON.stringify(reference)).toString("base64url")}`;
}

export function decodeMessageReference(value: string): MessageReference {
  try {
    const prefix = "dvdst-message:";
    if (!value.startsWith(prefix)) throw new Error();
    const ref: unknown = JSON.parse(Buffer.from(value.slice(prefix.length), "base64url").toString("utf8"));
    if (!isObject(ref) || ref.v !== 1 || typeof ref.path !== "string" || !isAbsolute(ref.path)
      || typeof ref.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(ref.fingerprint)
      || !Number.isSafeInteger(ref.seq) || (ref.seq as number) < 1
      || !Number.isSafeInteger(ref.line) || (ref.line as number) < 1
      || !(ref.id === null || typeof ref.id === "string")) throw new Error();
    return ref as unknown as MessageReference;
  } catch {
    throw new Error("Invalid message reference. Copy ref from dvdst messages, or messageRef from dvdst search.");
  }
}
