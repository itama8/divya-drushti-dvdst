# Capabilities and interfaces

This inventory describes the dvdst implementation and the project integrations
in `~/Projects/omakase-v2` inspected on 2026-10-24. Omakase adapters live in
that repository. Installing dvdst alone does not install those adapters.

## Session analysis

Pi, Claude Code, and Codex transcripts feed a common row interface:

- `overview`: session totals, models, tokens, recorded cost, and tool use
- `turns`: model requests, tokens, context use, and recorded timing
- `calls`: tool calls joined to results, failures, duration, output size,
  truncation, command classes, inferred bash file effects, and repetition
- `context`: recorded system prompt sections and sizes
- `schema`: field descriptions for built-in streams and project extractors
- `cache`: inspect or clear the derived row cache

```bash
dvdst overview --project omakase-v2 --source all --last 30
dvdst calls --project omakase-v2 --source claude --last 10 --errors
dvdst schema calls
```

Rows support JSONL, JSON, and TSV. `--full` includes arguments and result text.
Session selection accepts files, IDs, prefixes, and `latest`, with project,
root, time, and count filters. `--source all` means Pi, Claude Code, and Codex.
The default source for recent-session selection is Pi.

Claude conversion normalizes core tools to `bash`, `read`, `edit`, and `write`.
It excludes sidechain entries. Missing cost and generation timing stay null,
and there are no Claude system prompt rows. Codex rollouts feed the same commands. `--source codex` discovers rollouts
under `$CODEX_HOME/sessions` (default `~/.codex/sessions`), using recorded cwd
for project selection. Codex context exposes recorded base instructions only.
Its turns are assistant response items, rather than a guaranteed count of
provider requests. `last_token_usage` is attached once to the preceding
assistant item; cached input is separated from uncached input. Missing cost
and request start times remain null. Event echoes do not count as prompts.

Native shell calls and literal `functions.exec` batches with a complete,
unambiguous result list become command rows. Complex scripts stay opaque
`exec` calls. Running native shell calls stay unfinished until a recorded
`write_stdin` result supplies an exit status. Patch paths describe recorded
intent, including multi-file patches; they do not establish exact diffs.
Analysis and ingestion read the supplied file segment only. They do not join
paginated history or reconstruct fork ancestry; staging retains its stricter
verified pagination loader.

## Inspection and handoff

`files`, `commands`, `skills`, `trace`, `probe`, `handoff`, and `handoff-devlog`
read Pi, Claude Code, or Codex session evidence. They expose file operations, command
outcomes, skill loads and attribution, provenance, goals, recorded commits,
and compact closeout summaries or devlog drafts. Skill attribution is an
evidence-based association and does not prove model adherence.

```bash
dvdst files /path/to/claude-transcript.jsonl --format json
dvdst handoff /path/to/claude-transcript.jsonl
```

These commands use a direct bundle path. Their file summaries do not include
all inferred bash reads available in call rows and stored artifacts. Codex patch paths are included in direct file summaries.

## Recorded-change staging

`stage` accepts a Pi live stream or supported session evidence.
`session-stage --agent claude|codex` adds verified transcript discovery and
mutation listing for Claude Code and Codex.

```bash
dvdst stage --session-file /path/to/pi-session.jsonl --cwd /path/to/repo --dry-run
dvdst session-stage --agent claude --session-file /path/to/transcript.jsonl --list
dvdst session-stage --agent codex --session-file /path/to/rollout.jsonl --dry-run
```

- Pi supports successful exact edits and new-file writes.
- Claude supports successful Edit calls, including intentional `replace_all`,
  and Write calls for paths absent from HEAD.
- Codex supports successful Add File and exact Update File patch calls,
  including supported sequential literal exec wrappers. File loading joins
  verified same-session paginated segments. Deletes, moves, arbitrary wrapper
  code, and other unsupported patch forms are refused.

All routes replay recorded mutations from HEAD. They do not attribute arbitrary
shell writes. A manifest pins HEAD and selects successful mutation IDs across
sessions in explicit order. `--after` selects changes after a verified result
cursor following a commit. These tools stage and report conflicts. They do not
commit, prove semantic correctness, or automatically recover commit receipts.

Unrelated unstaged changes stay outside the staged replay. Unrelated staged
changes block publication. Tracked-file writes without pre-images are refused.
Ordinary reviewed Git staging remains supported when replay does not cover the
intended changes. See [session staging](session-staging.md) and
[manifests](stage-manifests.md) for exact contracts.

## Stored evidence and live streams

The stored session pipeline supports Pi, Claude Code, and Codex: `ingest`, `normalize`, `artifacts`,
and `events` preserve raw snapshots and derive records, artifact streams, and
findings. Raw snapshots stay verbatim in separate `sessions/pi`,
`sessions/claude`, and `sessions/codex` namespaces. Store readers resolve a
unique session ID across those namespaces and refuse ambiguous identities.
Canonical conversion preserves source line and byte references; unsupported
tools remain generic records. Findings include file modification without a prior observed read,
tests missing after the final mutation, and unresolved command failures.
`sessions` remains a Pi filename discovery command; use analysis selection
with `--source` for cross-agent discovery. `cleanup` removes a marked local store.

The live event contract takes producer-supplied events. The bundled recorder,
`examples/pi-extension/dvdst-live.ts`, targets Pi. There is no bundled Claude
or Codex live recorder. `live` validates and decomposes events, `ingest --live`
stores snapshots, `timeline` reads stored live evidence, and `export` renders
evidence as Markdown or CSV. The stored `timeline` and `export` forms read live
snapshots, not ordinary Pi session snapshots.

`review --input <events.jsonl> --watch` emits inferred review frames when Pi
settles after successful edit/write operations. It records mutation IDs and
validation observations. It does not start a reviewer or review repository
changes. See [live streams](live-streams.md).

## Programmatic and agent interfaces

- CLI: the `dvdst` binary, or `npm run --silent dvdst -- <command>` in this checkout
- Library: TypeScript exports from `dvdst`, including `loadSession`,
  `loadSessions`, row derivation, session resolution, bash effects, command
  classification, configuration, and extractor loading, for scripts run with tsx
- Project extractors: `.dvdst/extractors/` modules with `derive(session)` and
  optional `summarize(rows)`, run as `dvdst <name>` or `dvdst rows <name|file>`
- Project rules: `.dvdst/config.json` for command classes and finding exclusions
- Agent skill: `skills/dvdst-session-analysis/` for Pi, Claude Code, and Codex analysis
- Files and pipes: JSONL records, canonical store files, and CLI JSON/TSV output

There is no dvdst MCP server, HTTP service, dashboard, or automatic Git commit
interface in this checkout.

## Omakase project integrations

The following integrations reside in Omakase, not in the dvdst package:

| Integration | Interface | Current scope |
| --- | --- | --- |
| Pi staging extension | `stage_changes`, `/stage [repository]`, `/stage-manifest <file>` | Uses dvdst staging, prefers an existing live stream, otherwise reads the current session file |
| Claude staging adapter | `node .claude/skills/stage-changes/stage-changes.mjs` | Transcript discovery, listing, dry run, manifest selection, repository selection, and post-commit cursor |
| Codex staging adapter | `node .agents/skills/stage-changes/stage-changes.mjs` | Wraps dvdst `session-stage --agent codex` with the same selection controls |
| Commit workflow skills | `.pi/skills/session-commit`, `.claude/skills/session-commit`, `.agents/skills/session-commit` | Scope review, complete index inspection, validation, and an authorized Git commit, with dvdst optional |
| Review extension | `/review-session`, `/review-checkpoint`, `/reviews` | On disk but explicitly excluded by `.pi/settings.json` |

The staging adapters default to `~/Projects/dvdst`, overridable with
`DVDST_ROOT`. They require its dependencies. Pi project extension discovery
requires project trust and reload in existing sessions. The staging integration
is configured for use, while actual exposure depends on the host session.

The excluded review extension builds evidence packets using dvdst, prepares
isolated repository worktrees, and launches a Pi reviewer. Its paths consume
Pi session stores. It is an experimental Omakase orchestration layer and does
not establish Claude/Codex review support or an active automatic review service.
It is separate from dvdst's `review` frame command. The core dvdst commands
make no model calls, while this separate extension launches a model reviewer.
Reviewer wayfinding documents describe additional host controls and scheduling.
Those design decisions do not add runnable commands to the current extension.

Omakase contains contract scripts for the Pi staging extension, Claude and
Codex adapters, and commit skill discovery. These are distinct from dvdst's
parser, replay, and index-transaction tests.
