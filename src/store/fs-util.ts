import { rename, stat, writeFile } from "node:fs/promises";

export async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false);
}

/** Writes a small JSON file atomically with private permissions. */
export async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

/** Maps an arbitrary source or session identifier to a safe directory segment. */
export function sourceSegment(value: string): string {
  return encodeURIComponent(value);
}
