# Changelog

## Unreleased

- Lead with agent onboarding: runnable checkout setup, cross-agent query recipes,
  source selection and failure handling in `docs/agents.md`, root `AGENTS.md`,
  and the reusable session-analysis skill. Keep human workflows secondary.

- Add Codex session analysis, context, command/file inspection, handoffs, and
  cross-agent selection with `--source codex|all`. Preserve source references,
  normalize native shell calls and supported literal exec batches, join shell
  polling completions, and expose multi-file patch paths and recorded usage.
- Extend the stored ingestion, normalization, artifact, and finding pipeline to
  Claude Code and Codex with verbatim snapshots and separate agent namespaces.
  Live adapters and review frames remain Pi-only; analysis reads one rollout
  segment and leaves unsupported exec scripts opaque.

- Document source support by workflow and inventory CLI, library, extractor,
  skill, and Omakase extension interfaces. Claude Code analysis and Codex
  staging were initially distinguished from the Pi-only store and bundled live
  adapter; the store now supports all three agents as described above.
- `dvdst review --input <events.jsonl> [--watch]` emits inferred review frames
  when Pi settles after successful edits or writes. Frames list mutation
  evidence, failed commands, and successful tests after the final mutation.
  The Pi extension records agent start and settled events and shows recording
  status in Pi.
- `dvdst session-stage --agent claude|codex` discovers verified session
  evidence, lists mutation selectors, and stages exact recorded changes.
  Codex loading joins verified same-session paginated rollouts and supports
  sequential literal patch batches. `--after` selects mutations after an
  explicit committed-result cursor. See [session staging](docs/session-staging.md).
- `dvdst overview`, `turns`, `calls`, and `context` read session files directly
  and write JSONL rows: per-session totals, tokens and cost per model request,
  tool calls joined to their results with duration and truncation, and system
  prompt section sizes. `dvdst schema` prints the fields.
- Session commands accept a file, a session id or id prefix, a filename
  timestamp prefix, or `latest`. `--last`, `--since`, `--root`, and `--project`
  select several sessions. `handoff`, `handoff-devlog`, and `probe` accept the
  session as a positional argument.
- Rows without `--full` are cached per session file and reused while the
  session, the row logic, and the project rules are unchanged. `dvdst cache`
  shows the cache, `dvdst cache --clear` empties it, and `--no-cache` or
  `DVDST_CACHE=off` skips it.
- Call rows carry `verbs`, the programs a bash command runs, and three fields
  that relate a call to the calls before it: `rereads`, `commandAttempt`, and
  `failureRun`. Overview rows total them in `rereadCalls`, `rereadBytes`,
  `maxFailureRun`, and `inlineScriptCalls`.
- The classifier adds the built-in class `inline-script` and is version 3. The
  artifact extractor is version 3, and the bash parser is version 2.
- `skills/dvdst-session-analysis/SKILL.md` teaches a Pi or Claude Code agent
  to analyze sessions with the row commands. A test checks that every command,
  flag, and field it names exists.
- dvdst reads Claude Code sessions. The row streams, extractors, library,
  `handoff`, `files`, `commands`, and `trace` accept a Claude Code transcript
  and convert it to the entry shape the rest of dvdst reads: one turn per model
  request, and `bash`, `read`, `edit`, and `write` named and keyed as in Pi.
  `--source pi|claude|all` chooses whose sessions `latest`, `--last`, and
  `--since` select, and a session id is found whichever agent wrote it.
  Overview rows carry `source`. Cost is null where the source records none.
  The store commands still take Pi sessions only.
- `dvdst stage --session-file` accepts a Claude Code transcript, as a single
  session or as a manifest source. Successful `Edit` and `Write` calls replay
  like Pi edits and writes. Failed calls and subagent sidechain calls are
  skipped, and a transcript that carries more than one session ID is refused.
  A manifest selects a call by `<user entry uuid>:<result index>`.
- A project adds row streams with extractors: a file in `.dvdst/extractors/`
  that default-exports `{ derive(session) }`, with an optional `summarize`
  across sessions. `dvdst <name>` or `dvdst rows <name|file>` runs it with the
  selection and format options of the built-in streams, and `dvdst schema`
  lists it. `examples/extractors/` has two.
- The package exports a library, `loadSession`, `loadSessions`, and the row,
  bash, classifier, and configuration functions, for scripts run with tsx.
- Bash commands are parsed for the files they read and mutate. The artifact
  extractor writes `artifacts/bash-file-effects.jsonl`, and `dvdst calls` rows
  carry `reads`, `mutates`, and `opaque`. A successful bash read of a file now
  counts as a prior read for `file-modified-without-observed-read`, which also
  reports the `operation` of the first mutation.
- A project states command classes and paths to leave out of findings in
  `.dvdst/config.json`, found through the session cwd or named with `--config`.
  Derived output records which file applied. The built-in test rule also
  recognizes `node --test`, `tsx --test`, `go test`, `bun test`, `deno test`,
  and `make test`. The command classifier is version 2, and the artifact and
  event extractors are version 2.
- File findings leave out paths outside the session cwd.
- The handoff reports `created` commits read from `git commit` output. The
  loose hexadecimal matches are counted as `candidates` and no longer listed.
- `dvdst artifacts <session>` normalizes the snapshot first instead of failing
  on a missing `tool-invocations.jsonl`.
- `dvdst --help` lists every command with a description. The package declares
  a `dvdst` binary that runs from any working directory.
- `dvdst stage` stages exact session edits and writes to paths absent from HEAD
  from a live stream or Pi session file. Complete HEAD replay states make
  repeated staging safe for chained edits and deletions. One conflicting path
  or unrelated staged change blocks publication. The command prepares a private
  index under Git's lock and publishes it once. Repository selection preserves
  recorded relative paths. Bash mutation warnings remain heuristic.
- Staging rejects tracked-file writes without pre-images, mixed-session streams,
  inherited fork-file mutations, malformed evidence, and unsupported Git entries.
  Start a new session after committing.

## 0.1.0 - first release

`dvdst` turns Pi coding-agent sessions into structured, deterministic
development evidence. This release covers the full evidence pipeline for the
Omakase corpus, tested fixtures, and a measured production run.

### Pipeline

- `dvdst ingest` - content-addressed raw snapshots of Pi session files with
  append, replacement, truncation, and unchanged change detection. Write to a
  temporary snapshot directory, rename into place, retry-safe.
- `dvdst normalize` - messages, tool calls, tool results, and an append-order
  timeline; large payloads move to a shared SHA-256 blob store; orphan calls
  and results stay visible as diagnostics.
- `dvdst artifacts` - file reads, file mutations, searches, commands, tests,
  and unknown tools. Mutation records state whether a patch is observed,
  reconstructed, or inferred, and never claim an exact final diff without
  repository state.
- `dvdst skills` - explicit `/skill:` commands and model `SKILL.md` loads with
  historical content hashes, plus conservative same-turn attribution that
  keeps overlaps and explains each label.
- `dvdst events` - deterministic command-succeeded, command-failed, file-read,
  and file-mutation events plus three findings: file modified without an
  observed prior read, tests not run after the final mutation, and unresolved
  command failure with exact-text retry matching.
- `dvdst live` - converts an append-only live event stream from the Pi
  extension into observed evidence.
- `dvdst handoff` / `dvdst handoff-devlog` - compact closeout summary and an
  Omakase devlog draft from structured evidence, no prose generation.
- `dvdst cleanup` - removes a local store after marker and confirmation checks.

### Evidence surface

- Canonical file + JSONL store under `store/` with `records/`, `artifacts/`,
  `events/`, and content-addressed `blobs/`.
- Provenance on every normalized artifact and event: session id, entry id,
  line, and byte range back into the raw snapshot.
- Confidence vocabulary fixed to `observed`, `reconstructed`, `inferred`;
  derived claims state their rule and their limit.
- Deterministic and idempotent: re-running an extractor rewrites
  byte-identical output and never touches the raw source snapshot.
- No runtime dependencies, no model calls, no network.

### Benchmarks and hardening

- Ten-case benchmark against real Omakase sessions (docs/benchmark-report.md):
  every case matches its devlog status, four use explicit `/skill:` commands,
  and context reduction ranges from 82x to over 1100x.
- Corpus run (docs/corpus-report.json): 396 sessions, 0 parse diagnostics,
  ~6.6s, ~221 MB peak RSS, repeat run performs no writes.
- Cookbook of tested jq recipes (docs/cookbook.md) for skill versions,
  attributed tool use, validation, failures, and outcomes.

### Breaking changes

None - this is the first release.

### Not in this release

- MCP or HTTP server, Hermes profiles, SQLite canonical store, live background
  watching, model-assisted semantic events, and non-Pi harnesses remain out of
  scope per the project plan.
