import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandClassRule } from "../pi/classify-commands.js";
import { isObject } from "../pi/read-jsonl.js";

export const CONFIG_RELATIVE_PATH = join(".dvdst", "config.json");

export interface ProjectConfig {
  /** The file the rules came from, or null when the project has none. */
  path: string | null;
  /** SHA-256 of the file, so derived output can state which rules produced it. */
  sha256: string | null;
  /** Extra command classes, applied after the built-in rules. */
  commandClasses: CommandClassRule[];
  /** Paths, relative to the session cwd, that findings leave out. */
  ignorePaths: RegExp[];
}

export const EMPTY_CONFIG: ProjectConfig = { path: null, sha256: null, commandClasses: [], ignorePaths: [] };

function compile(source: unknown, where: string): RegExp {
  if (typeof source !== "string" || source.length === 0) throw new Error(`${where} must be a non-empty regular expression string`);
  try {
    return new RegExp(source);
  } catch (error) {
    throw new Error(`${where} is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseConfig(text: string, path: string): ProjectConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(value)) throw new Error(`${path}: must be a JSON object`);
  for (const key of Object.keys(value)) {
    if (key !== "commandClasses" && key !== "findings") throw new Error(`${path}: unknown key ${JSON.stringify(key)}; expected commandClasses or findings`);
  }

  const commandClasses: CommandClassRule[] = [];
  const rules = value.commandClasses ?? [];
  if (!Array.isArray(rules)) throw new Error(`${path}: commandClasses must be an array`);
  for (const [index, rule] of rules.entries()) {
    const where = `${path}: commandClasses[${index}]`;
    if (!isObject(rule)) throw new Error(`${where} must be an object`);
    if (typeof rule.name !== "string" || rule.name.length === 0) throw new Error(`${where}.name must be a non-empty string`);
    if (rule.reason !== undefined && typeof rule.reason !== "string") throw new Error(`${where}.reason must be a string`);
    commandClasses.push({
      name: rule.name,
      pattern: compile(rule.pattern, `${where}.pattern`),
      reason: rule.reason ?? `project rule ${index + 1} in ${CONFIG_RELATIVE_PATH}`,
    });
  }

  const ignorePaths: RegExp[] = [];
  const findings = value.findings ?? {};
  if (!isObject(findings)) throw new Error(`${path}: findings must be an object`);
  const ignored = findings.ignorePaths ?? [];
  if (!Array.isArray(ignored)) throw new Error(`${path}: findings.ignorePaths must be an array`);
  for (const [index, pattern] of ignored.entries()) ignorePaths.push(compile(pattern, `${path}: findings.ignorePaths[${index}]`));

  return { path, sha256: createHash("sha256").update(text).digest("hex"), commandClasses, ignorePaths };
}

/**
 * Loads the project rules that sit beside the code a session worked on.
 *
 * The rules live in `<session cwd>/.dvdst/config.json`, so a session is
 * classified the same way from any working directory. A project without the
 * file gets the built-in rules only. A file that exists but is invalid is an
 * error, because silently ignoring it would change every derived class.
 */
export async function loadProjectConfig(options: { cwd?: string | null | undefined; configPath?: string | undefined }): Promise<ProjectConfig> {
  if (options.configPath !== undefined) return parseConfig(await readFile(options.configPath, "utf8"), options.configPath);
  if (options.cwd === undefined || options.cwd === null) return EMPTY_CONFIG;
  const path = join(options.cwd, CONFIG_RELATIVE_PATH);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return EMPTY_CONFIG;
    throw error;
  }
  return parseConfig(text, path);
}
