import type { HandoffSummary } from "../handoff/summary.js";

export interface DevlogFrontmatter {
  date: string;
  session: number;
  project: string;
  phase: string;
  checkpoint: string;
  status: string;
  focus: string;
  worked_on: string;
  contracts_touched: string[];
  drift_status: string;
  commit: string;
  commits: string[];
  commit_match_confidence: number;
  commit_match_notes: string;
  session_outcome: string;
  next_files: string[];
  handoff_ready: boolean;
}

export function devlogFromSummary(summary: HandoffSummary, options: { date: string; session: number; project: string; phase: string; checkpoint: string; focus: string }): string {
  const frontmatter: DevlogFrontmatter = {
    date: options.date,
    session: options.session,
    project: options.project,
    phase: options.phase,
    checkpoint: options.checkpoint,
    status: summary.status === "unknown" ? "planned" : summary.status,
    focus: options.focus,
    worked_on: options.focus,
    contracts_touched: summary.files.modified,
    drift_status: "none",
    commit: summary.commits.matched[0] ?? "none",
    commits: summary.commits.matched,
    commit_match_confidence: summary.commits.expected.length === 0 ? 0.5 : summary.commits.matched.length / Math.max(1, summary.commits.expected.length),
    commit_match_notes: summary.commits.matched.length > 0 ? "Auto-derived from Pi session evidence." : "No matching commit found in transcript; verify manually.",
    session_outcome: summary.outcome === "stable" ? "accepted" : summary.outcome,
    next_files: summary.nextFiles.expected.length > 0 ? summary.nextFiles.expected : summary.files.read.slice(0, 3),
    handoff_ready: true,
  };

  const yamlLines: string[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        yamlLines.push(`${key}: []`);
        continue;
      }
      yamlLines.push(`${key}:`);
      for (const item of value) yamlLines.push(`  - ${item}`);
      continue;
    }
    yamlLines.push(`${key}: ${value}`);
  }
  const yaml = yamlLines.join("\n");

  const bodyLines: string[] = [];
  bodyLines.push(`# ${options.checkpoint}`);
  bodyLines.push("");
  bodyLines.push("## Goal");
  bodyLines.push(options.focus);
  bodyLines.push("");
  bodyLines.push("## Evidence");
  bodyLines.push(`- Status from Pi evidence: ${summary.status}`);
  bodyLines.push(`- Outcome: ${summary.outcome}`);
  bodyLines.push(`- Modified files: ${summary.files.modified.length}`);
  bodyLines.push(`- Commands: total=${summary.commands.total} failed=${summary.commands.failed} tests=${summary.commands.tests}`);
  bodyLines.push(`- Commits matched: ${summary.commits.matched.length} (expected ${summary.commits.expected.length})`);
  if (summary.skills.names.length > 0) bodyLines.push(`- Skills observed: ${summary.skills.names.join(", ")}`);
  bodyLines.push("");
  bodyLines.push("## Source");
  bodyLines.push(`- Session: ${summary.session.id}`);
  bodyLines.push(`- Path: ${summary.source.path}`);

  return `---\n${yaml}\n---\n\n${bodyLines.join("\n")}\n`;
}
