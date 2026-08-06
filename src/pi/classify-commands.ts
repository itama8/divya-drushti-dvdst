export function classifyCommand(command: string): string[] {
  const classes: string[] = [];
  if (/(^|\s)(npm|pnpm|yarn)\s+(run\s+)?test(?=[:\s]|$)|\bcargo\s+test\b|\bpytest\b|\bvitest\b|\bjest\b/.test(command)) classes.push("test");
  if (/\b(typecheck|tsc\s+(?:-[^\s]+\s+)*--noEmit)\b/.test(command)) classes.push("typecheck");
  if (/(^|\s)(npm|pnpm|yarn)\s+run\s+build\b|\bcargo\s+build\b/.test(command)) classes.push("build");
  if (/\b(lint|eslint|biome\s+check)\b/.test(command)) classes.push("lint");
  return classes;
}
