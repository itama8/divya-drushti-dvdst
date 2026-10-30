import { isAbsolute } from "node:path";
import { isObject } from "../pi/read-jsonl.js";

export interface CallReference {
  v: 1;
  path: string;
  fingerprint: string;
  callId: string;
  line: number;
}

export function encodeCallReference(reference: CallReference): string {
  return `dvdst-call:${Buffer.from(JSON.stringify(reference)).toString("base64url")}`;
}

export function decodeCallReference(value: string): CallReference {
  try {
    if (!value.startsWith("dvdst-call:")) throw new Error();
    const ref: unknown = JSON.parse(Buffer.from(value.slice(11), "base64url").toString("utf8"));
    if (!isObject(ref) || ref.v !== 1 || typeof ref.path !== "string" || !isAbsolute(ref.path)
      || typeof ref.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(ref.fingerprint)
      || typeof ref.callId !== "string" || !Number.isSafeInteger(ref.line) || (ref.line as number) < 1) throw new Error();
    return ref as unknown as CallReference;
  } catch {
    throw new Error("Invalid call reference. Copy ref from dvdst calls output.");
  }
}
