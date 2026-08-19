export const COMMAND_CLASSIFIER_VERSION = 1;

export interface CommandClass {
  name: string;
  reason: string;
}

const CLASS_RULES: Array<{ name: string; pattern: RegExp; reason: string }> = [
  { name: "test", pattern: /(^|\s)(npm|pnpm|yarn)\s+(run\s+)?test(?=[:\s]|$)|\bcargo\s+test\b|\bpytest\b|\bvitest\b|\bjest\b/, reason: "package-manager test command or dedicated test runner" },
  { name: "typecheck", pattern: /\b(typecheck|tsc\s+(?:-[^\s]+\s+)*--noEmit)\b/, reason: "typecheck script or tsc --noEmit" },
  { name: "build", pattern: /(^|\s)(npm|pnpm|yarn)\s+run\s+build\b|\bcargo\s+build\b/, reason: "package-manager build script or cargo build" },
  { name: "lint", pattern: /\b(lint|eslint|biome\s+check)\b/, reason: "lint script or linting tool invocation" },
  { name: "dependency", pattern: /(^|\s)(npm|pnpm|yarn)\s+(install|ci|add|remove|update)\b|\bcargo\s+(add|update|remove)\b|\bpip\s+install\b|\bapt(-get)?\s+install\b/, reason: "dependency installation or update command" },
];

/**
 * Classifies a shell command as test, typecheck, build, lint, or dependency.
 * The result is deterministic: one class per matched rule, in rule order.
 * Each class names its matching rule, so consumers can audit or regenerate
 * the classification with the recorded classifier version.
 */
export function classifyCommandWithReasons(command: string): CommandClass[] {
  return CLASS_RULES.filter((rule) => rule.pattern.test(command)).map((rule) => ({ name: rule.name, reason: rule.reason }));
}

/** Backward-compatible helper: returns class names only. */
export function classifyCommand(command: string): string[] {
  return classifyCommandWithReasons(command).map((classification) => classification.name);
}