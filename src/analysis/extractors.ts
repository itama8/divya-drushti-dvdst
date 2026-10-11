import { readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isObject } from "../pi/read-jsonl.js";
import type { FieldSpec, Row } from "./rows.js";
import type { SessionData } from "./session.js";

/**
 * A row stream defined outside dvdst. An extractor file default-exports one:
 *
 *   export default {
 *     description: "slow commands",
 *     derive: (session) => session.calls.filter((call) => call.durationMs > 60000),
 *   };
 *
 * dvdst supplies session selection, project rules, and output formats.
 */
export interface Extractor {
  /** Stream name. Defaults to the file name without its extension. */
  name?: string;
  description?: string;
  /** Declared fields. They give `dvdst schema` its text and TSV its column order. */
  fields?: FieldSpec[];
  /** Rows of one session. */
  derive(session: SessionData): Row[] | Iterable<Row> | Promise<Row[] | Iterable<Row>>;
  /** Reduces the rows of every selected session to the rows to print, for counts and rankings across sessions. */
  summarize?(rows: Row[]): Row[] | Promise<Row[]>;
}

export interface LoadedExtractor extends Extractor {
  name: string;
  description: string;
  file: string;
}

const EXTRACTOR_FILE = /\.(ts|mts|mjs|js)$/;

export function isExtractorFile(value: string): boolean {
  return EXTRACTOR_FILE.test(value) && !value.endsWith(".d.ts");
}

/**
 * Directories searched for extractors: `.dvdst/extractors` under the working
 * directory, then each directory in `DVDST_EXTRACTORS`. They are chosen by the
 * caller, never by a session, because an extractor is code that runs.
 */
export function extractorDirectories(cwd = process.cwd(), env: Record<string, string | undefined> = process.env): string[] {
  const extra = (env.DVDST_EXTRACTORS ?? "").split(":").filter((entry) => entry.length > 0);
  return [join(cwd, ".dvdst", "extractors"), ...extra];
}

export async function loadExtractorFile(file: string): Promise<LoadedExtractor> {
  const absolute = resolve(file);
  let module: unknown;
  try {
    module = await import(pathToFileURL(absolute).href);
  } catch (error) {
    throw new Error(`Cannot load extractor ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const extractor = isObject(module) ? module.default : undefined;
  if (!isObject(extractor) || typeof extractor.derive !== "function") {
    throw new Error(`Extractor ${file} must default-export an object with a derive(session) function`);
  }
  if (extractor.summarize !== undefined && typeof extractor.summarize !== "function") {
    throw new Error(`Extractor ${file}: summarize must be a function`);
  }
  const candidate = extractor as unknown as Extractor;
  return {
    ...candidate,
    name: typeof candidate.name === "string" && candidate.name.length > 0 ? candidate.name : basename(absolute).replace(EXTRACTOR_FILE, ""),
    description: typeof candidate.description === "string" ? candidate.description : "",
    file: absolute,
  };
}

/** Lists extractor files by stream name. The first directory that has a name wins. */
export async function listExtractorFiles(directories = extractorDirectories()): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const directory of directories) {
    const names = (await readdir(directory).catch(() => [] as string[])).filter(isExtractorFile).sort();
    for (const name of names) {
      const stream = name.replace(EXTRACTOR_FILE, "");
      if (!found.has(stream)) found.set(stream, join(directory, name));
    }
  }
  return found;
}

/** Finds an extractor by file path or by the name of a file in the extractor directories. */
export async function findExtractor(nameOrFile: string, directories = extractorDirectories()): Promise<LoadedExtractor | undefined> {
  if (nameOrFile.includes("/") || isExtractorFile(nameOrFile)) return loadExtractorFile(nameOrFile);
  const file = (await listExtractorFiles(directories)).get(nameOrFile);
  return file === undefined ? undefined : loadExtractorFile(file);
}
