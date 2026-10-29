# DVDST for agents

DVDST is agent first. Prefer structured, composable CLI output and compact
source-backed evidence. Pi, Claude Code, and Codex share the analysis interface.

## Use the tool

From this checkout, install with `npm ci --include=dev` (Node 22+) if needed.
No build or model credentials are required. Start with:

```bash
node bin/dvdst.mjs schema calls
node bin/dvdst.mjs overview test/fixtures/claude-session.jsonl
```

Read [docs/agents.md](docs/agents.md) for real session selection, task recipes,
output contracts, source limits, and troubleshooting. Read
[skills/dvdst-session-analysis/SKILL.md](skills/dvdst-session-analysis/SKILL.md)
when analyzing sessions. From another repository, invoke
`node /absolute/path/to/dvdst/bin/dvdst.mjs`; it resolves its own dependencies
while retaining the caller's working directory for project selection.

- Prefer an exact transcript path for a known agent session. For discovery,
  analysis supports `--source pi|claude|codex|all`; Pi remains the default.
- Start with `overview`, consult `schema`, then query focused `calls` or `turns`.
  Add `--full` only when arguments or result text are needed.
- Analysis reads transcripts directly. `events <file> --store <directory>`
  creates stored evidence and findings when that workflow is needed.
- Cite `session` and source `line`. Null outcome or cost means unknown; inferred
  file effects and findings do not prove ownership, correctness, or acceptance.
- Staging changes the Git index and never commits. It is optional. Use its
  [documented dry-run/manifest workflow](docs/session-staging.md) when requested;
  ordinary reviewed Git staging is also supported.

## Work on this repository

- Source detection/conversion: `src/sources/`; rows and schemas: `src/analysis/`.
- Discovery: `src/pi/resolve-sessions.ts`; CLI dispatch: `src/cli/dvdst.ts`.
- Stored evidence: `src/store/`, `src/normalize/`, `src/artifacts/`, `src/events/`.
- Attribution and index transactions: `src/stage/`; changes here must preserve
  exact replay, HEAD pinning, and protection of unrelated staged/unstaged work.
- Preserve raw source bytes and source line/byte provenance. Retain unsupported
  tools as generic evidence rather than inventing effects or executing scripts.
- For behavior changes, run `npm run typecheck` and `npm test`. Add regression
  coverage for source conversion, missing results, and evidence boundaries.
- Update [docs/interfaces.md](docs/interfaces.md), the README, relevant feature
  docs, and the bundled skill when changing an agent-facing contract.
- Do not commit session archives, local evidence stores, credentials, or private
  paths from real transcripts. Tests should use synthetic fixtures/temp stores.
