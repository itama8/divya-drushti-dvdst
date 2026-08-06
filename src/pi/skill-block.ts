import { basename, dirname } from "node:path";

export interface ParsedSkillBlock {
  name: string;
  path: string;
  body: string;
  userMessage?: string;
}

export function parseSkillBlock(text: string): ParsedSkillBlock | undefined {
  const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
  if (!match?.[1] || !match[2] || match[3] === undefined) return undefined;
  const userMessage = match[4]?.trim();
  return userMessage ? { name: match[1], path: match[2], body: match[3], userMessage } : { name: match[1], path: match[2], body: match[3] };
}

export function skillNameFromContent(text: string, path: string): string {
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  const name = frontmatter?.match(/^name:\s*["']?([^\r\n"']+)["']?\s*$/m)?.[1]?.trim();
  return name || basename(dirname(path));
}
