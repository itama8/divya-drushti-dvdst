const HASH_PATTERN = /\b[0-9a-f]{7,40}\b/gi;
const COMMIT_OUTPUT_LINE = /^\[[^\]\n]*?\s([0-9a-f]{7,40})\]/i;

/**
 * Every hexadecimal word that could be a commit id. This is deliberately
 * loose: it exists to match the commits a devlog names, wherever the session
 * printed them. It is not a list of commits the session made.
 */
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

/**
 * Commits a command created, read from the `[branch abc1234] subject` line
 * that `git commit`, `git cherry-pick`, and `git revert` print.
 */
export function extractCreatedCommits(text: string): string[] {
  const commits = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = COMMIT_OUTPUT_LINE.exec(line);
    if (match) commits.add(match[1]!.toLowerCase());
  }
  return [...commits];
}
