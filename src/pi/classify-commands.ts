import { parseBashEffects } from "./bash-effects.js";

export const COMMAND_CLASSIFIER_VERSION = 3;

export interface CommandClass {
  name: string;
  reason: string;
}

export interface CommandClassRule {
  name: string;
  pattern: RegExp;
  reason: string;
}

const CLASS_RULES: CommandClassRule[] = [
  { name: "test", pattern: /(^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?test(?=[:\s]|$)|\b(cargo|go|deno|bun|make)\s+test\b|\b(node|tsx)\s+(?:\S+\s+)*--test\b|\bpytest\b|\bvitest\b|\bjest\b/, reason: "package-manager test command or dedicated test runner" },
  { name: "typecheck", pattern: /\b(typecheck|tsc\s+(?:-[^\s]+\s+)*--noEmit)\b/, reason: "typecheck script or tsc --noEmit" },
  { name: "build", pattern: /(^|\s)(npm|pnpm|yarn)\s+run\s+build\b|\bcargo\s+build\b/, reason: "package-manager build script or cargo build" },
  { name: "lint", pattern: /\b(lint|eslint|biome\s+check)\b/, reason: "lint script or linting tool invocation" },
  { name: "dependency", pattern: /(^|\s)(npm|pnpm|yarn)\s+(install|ci|add|remove|update)\b|\bcargo\s+(add|update|remove)\b|\bpip\s+install\b|\bapt(-get)?\s+install\b/, reason: "dependency installation or update command" },
];

const INLINE_SCRIPT = "inline-script";

/**
 * Classifies a shell command as test, typecheck, build, lint, dependency, or
 * inline-script.
 * The result is deterministic: one class per matched rule, built-in rules
 * first, then the project rules in their configured order. Each class names
 * its matching rule, so consumers can audit or regenerate the classification
 * with the recorded classifier version and project configuration.
 */
export function classifyCommandWithReasons(command: string, projectRules: CommandClassRule[] = []): CommandClass[] {
  const classes: CommandClass[] = [];
  for (const rule of [...CLASS_RULES, ...projectRules]) {
    if (!rule.pattern.test(command) || classes.some((known) => known.name === rule.name)) continue;
    classes.push({ name: rule.name, reason: rule.reason });
  }
  // A script typed into the command, such as `node -e` or `python3 - <<EOF`,
  // is found by parsing, because a heredoc alone may only write a file.
  if (!classes.some((known) => known.name === INLINE_SCRIPT) && parseBashEffects(command).opaque.some((reason) => reason.startsWith("inline "))) {
    classes.push({ name: INLINE_SCRIPT, reason: "interpreter run on a script given in the command text" });
  }
  return classes;
}

/** Backward-compatible helper: returns class names only. */
export function classifyCommand(command: string, projectRules: CommandClassRule[] = []): string[] {
  return classifyCommandWithReasons(command, projectRules).map((classification) => classification.name);
}
