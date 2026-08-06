export interface DevlogFrontmatter {
  status?: string;
  contractsTouched: string[];
  commits: string[];
  nextFiles: string[];
}

type ListKey = "contractsTouched" | "commits" | "nextFiles";

export function parseDevlogFrontmatter(markdown: string): DevlogFrontmatter {
  const block = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (!block) return { contractsTouched: [], commits: [], nextFiles: [] };

  const result: DevlogFrontmatter = { contractsTouched: [], commits: [], nextFiles: [] };
  let currentKey: ListKey | undefined;

  for (const line of block.split(/\r?\n/)) {
    const keyMatch = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (keyMatch?.[1]) {
      const key = keyMatch[1];
      const value = keyMatch[2]?.trim();
      currentKey = undefined;

      if (key === "status") {
        if (value !== undefined) result.status = value;
      }
      else if (key === "contracts_touched") currentKey = "contractsTouched";
      else if (key === "commits") currentKey = "commits";
      else if (key === "next_files") currentKey = "nextFiles";
      else if (key === "commit") {
        if (value && value !== "none") result.commits.push(value);
      }

      if (currentKey && value?.startsWith("[") && value.endsWith("]")) {
        const list = result[currentKey];
        for (const item of value.slice(1, -1).split(",").map((entry) => entry.trim()).filter(Boolean)) list.push(item);
        currentKey = undefined;
      }
      continue;
    }

    const itemMatch = line.match(/^\s+-\s+(.+)$/)?.[1]?.trim();
    if (itemMatch && currentKey) result[currentKey].push(itemMatch.replace(/^['"]|['"]$/g, ""));
  }

  return result;
}
