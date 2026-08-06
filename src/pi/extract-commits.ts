const HASH_PATTERN = /\b[0-9a-f]{7,40}\b/gi;

export function extractCommitCandidates(text: string): string[] {
  const commits = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const commitLine = line.match(/^\[[^\]]+\s+([0-9a-f]{7,40})\]/i);
    const fullLine = line.match(/^([0-9a-f]{40})$/i);
    const value = commitLine?.[1] ?? fullLine?.[1];
    if (value) {
      commits.add(value.toLowerCase());
      continue;
    }
    for (const candidate of line.match(HASH_PATTERN) ?? []) {
      if (candidate.length < 7 || candidate.length > 40) continue;
      commits.add(candidate.toLowerCase());
    }
  }
  return [...commits];
}
