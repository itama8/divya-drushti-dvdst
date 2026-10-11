# How to use dvdst

This guide shows how to run the probe, the handoff, the devlog mapper, the benchmark, and the new narrow inspection commands on real Omakase data.

## 1. Install

```bash
git clone https://github.com/itama8/divya-drushti-dvdst.git
cd divya-drushti-dvdst
npm install
```

The current release is built and validated against Pi sessions from the Omakase development corpus and uses Node.js 22 or newer. It has no runtime dependencies, only `tsx`, `typescript`, and `@types/node` as dev dependencies.

## 2. Validate the build

```bash
npm run typecheck
npm test
```

You should see:

- `npm run typecheck` exit with no errors.
- `npm test` report all discovered tests passing.

## 3. Run the probe on a real session

Pick a session and a devlog. A real pair is:

```bash
SESSION="$HOME/.pi/agent/sessions/--home-a2ajinkya-Projects-omakase-v2--/2026-08-03T22-23-26-179Z_019fc9b9-83e3-7d68-9d33-db78c83c576f.jsonl"
DEVLOG="/home/a2ajinkya/Projects/omakase-v2/.devlog/2026-08-04-s02.md"
```

Show the full evidence as a single JSON document:

```bash
npm run probe -- --session "$SESSION" --devlog "$DEVLOG" --pretty
```

Or write the full evidence and the focused streams to a directory:

```bash
mkdir -p /tmp/dvdst-out
npm run probe -- --session "$SESSION" --devlog "$DEVLOG" --out /tmp/dvdst-out
ls /tmp/dvdst-out
```

The output directory contains:

- `bundle.json` - the full evidence
- `skills.jsonl` - one skill invocation per line
- `attributions.jsonl` - one attributed record per line, each with its label array
- `commands.jsonl` - one shell command per line with previews and result evidence
- `files.jsonl` - one file path per line with its operation history

Pipe any stream through `jq` for narrow queries:

```bash
jq 'select(.path | startswith("docs/"))' /tmp/dvdst-out/files.jsonl
jq -c 'select(.labels | length > 0)' /tmp/dvdst-out/attributions.jsonl
jq -c 'select(.classes | index("test"))' /tmp/dvdst-out/commands.jsonl
```

## 4. Show a compact handoff summary

The handoff command is what a maintainer or another agent would read first.

```bash
npm run handoff -- --session "$SESSION" --devlog "$DEVLOG"
```

Or request JSON instead of text:

```bash
npm run handoff -- --session "$SESSION" --devlog "$DEVLOG" --format json | jq '{status, outcome, "files": (.files.modified | length), "commands": .commands.total, "skills": .skills.names}'
```

## 5. Generate a draft devlog from a session

When the session did not produce a devlog yet, `handoff-devlog` writes one from the handoff evidence. It derives the frontmatter and an evidence body.

```bash
npm run handoff-devlog -- --session "$SESSION" --out /tmp/dvdst-draft.md \
  --project omakase-v2 \
  --phase docs-spine \
  --checkpoint auto-derived \
  --focus "Recent feature documentation reconciliation" \
  --date 2026-08-04 \
  --session-num 99
head -25 /tmp/dvdst-draft.md
```

The output contains:

- the same frontmatter fields the Omakase devlogs use
- the implementation commit when matched
- a `commit_match_confidence` value derived from matched versus expected commits
- a short evidence body that references the source session

## 6. Discover sessions and inspect narrow streams

Use these commands when you only need a small slice of evidence.

List Pi session files in a directory:

```bash
npm run dvdst -- sessions "$HOME/.pi/agent/sessions/--home-a2ajinkya-Projects-omakase-v2--" --format tsv --limit 3
```

Filter files by path substring:

```bash
npm run dvdst -- files "$SESSION" --path docs/plans
```

List shell commands classified as tests:

```bash
npm run dvdst -- commands "$SESSION" --class test
```

List every skill invocation with its content hash and active line range:

```bash
npm run dvdst -- skills "$SESSION"
```

Query the same streams from the evidence store, with load status and three views
(invocations, spans, attributions):

```bash
npm run --silent dvdst -- skills --store .dvdst/store --session <session-id> \
  --view spans --format json
npm run --silent dvdst -- skills --store .dvdst/store --session <session-id> \
  --view attributions --format tsv
```

Look up the provenance of a specific record by its ID:

```bash
npm run dvdst -- trace "$SESSION" --id run-test
```

All four inspection commands support `--format json` for structured pipelines.

For the full set of tested jq recipes - skill version comparison, attributed
tool use, failures, validation, and per-session outcomes - see
[`docs/cookbook.md`](cookbook.md).

## 6a. Analyze sessions as rows

Four commands read session files directly and write one JSON object per line.
They need no store and no prior ingest.

| command | one row per | answers |
| --- | --- | --- |
| `overview` | session | how long, how many tokens, what it cost, which tools |
| `turns` | model request | tokens, cost, model, and generation time per request |
| `calls` | tool call joined to its result | what ran, how long, how much came back, what failed |
| `context` | system prompt section | what the session started with, and its size |

Every row carries the session id, so rows from many sessions can share one
file. `dvdst schema` prints every field with its type and meaning:

```bash
dvdst schema calls
```

### Name a session

Every command that reads a session accepts the same forms:

```bash
dvdst calls /path/to/session.jsonl      # a file
dvdst calls 01a1180d                    # a session id or id prefix
dvdst calls 2026-10-07T20-28            # a filename timestamp prefix
dvdst calls latest                      # the newest session
dvdst calls                             # the session in $PI_SESSION_FILE
```

An id, a prefix, and `latest` look in the Pi session directory of the working
directory. An id that matches nothing there is looked up in every project.
Choose another place with `--root <dir>` or `--project <name>`, where the name
is the end of a Pi project directory name such as `omakase-v2`.

Select several sessions with `--last <n>` or `--since <date>`:

```bash
dvdst overview --project omakase-v2 --last 50
dvdst calls --project omakase-v2 --since 2026-10-01 --errors
```

Bash calls carry `verbs`, the programs the command runs (`git diff`,
`npm run build`, `rg`), `reads` and `mutates`, the files the command text
names, and `opaque`, the reasons a command may change files it does not name.

Three fields relate a call to the calls before it. `rereads` lists files the
call read again with nothing changed in between: the read tool with the same
offset and limit, or a whole-file bash read such as `cat`. `commandAttempt`
counts how many times the session has run that exact bash command.
`failureRun` counts consecutive failed calls. `overview` totals them in
`rereadCalls`, `rereadBytes`, `maxFailureRun`, and `inlineScriptCalls`. `classes`
uses the built-in rules and the project's `.dvdst/config.json`; see
[`docs/events.md`](events.md#project-rules).

### Pi and Claude Code sessions

dvdst reads sessions of both agents and tells them apart by content. Rows
have one shape for both, and `overview` rows name the agent in `source`.

```bash
dvdst overview --project omakase-v2 --source claude
dvdst overview --project omakase-v2 --source all --since 2026-10-10
dvdst calls 8f7da1f7 --errors          # an id is found whichever agent wrote it
```

`latest`, `--last`, and `--since` select Pi sessions unless `--source claude`
or `--source all` says otherwise. `DVDST_SOURCE` sets the default. Sessions of
both agents are ordered by start time.

A Claude Code session differs in what it records:

- The core tools are reported as `bash`, `read`, `edit`, and `write`, with a
  `path` and `edits` beside the original arguments. Other tools keep their
  Claude Code names.
- One model request is one turn, though the transcript spreads it over one
  entry per content block. `line` is the first of them.
- A call starts when its own block arrived, so `durationMs` is not an upper
  bound.
- `cost`, `startedAt` and `generationMs` of a turn, and the system prompt are
  not recorded. They are null, and `context` has no rows.
- Subagent sidechain entries are left out.

`handoff`, `files`, `commands`, and `trace` accept a Claude Code session too.
The store commands, `ingest`, `normalize`, `artifacts`, `events`, and `stage`,
take Pi sessions only.

`calls` takes `--tool <name>` and `--errors`. `--full` adds the arguments and
result text to `calls` and the section text to `context`. `--format tsv` and
`--format json` replace the JSONL default.

### Recipes

The five most expensive recent sessions:

```bash
dvdst overview --project omakase-v2 --last 50 \
  | jq -s 'sort_by(-.cost)[:5][] | {session, cost, turns, calls, firstPrompt}'
```

Failing commands across sessions, most frequent first:

```bash
dvdst calls --project omakase-v2 --last 50 --tool bash --errors \
  | jq -r '.command | .[0:60]' | sort | uniq -c | sort -rn | head
```

Files that agents read past Pi's output limit:

```bash
dvdst calls --project omakase-v2 --last 50 --tool read \
  | jq -r 'select(.truncated) | .path' | sort | uniq -c | sort -rn | head
```

Files changed through bash instead of the edit tools:

```bash
dvdst calls --project omakase-v2 --last 50 --tool bash \
  | jq -r '.mutates[] | select(startswith("/tmp") | not)' | sort | uniq -c | sort -rn | head
```

How much work each session did before its first edit:

```bash
dvdst overview --project omakase-v2 --last 50 \
  | jq -c '{session, callsBeforeFirstMutation, models}'
```

The slowest tool calls of one session:

```bash
dvdst calls latest | jq -s 'sort_by(-.durationMs)[:5][] | {seq, tool, durationMs, command, path}'
```

Context growth over one session:

```bash
dvdst turns latest --format tsv | cut -f2,17,18
```

The rows describe what the session file records. `durationMs` of calls made
in one assistant message is an upper bound, because Pi records one start time
for the message. A session file with a malformed line is skipped with a
message on stderr, and the command exits 1 after writing the other sessions.

### The row cache

Rows without `--full` are cached per session file under
`$XDG_CACHE_HOME/dvdst/rows`, by default `~/.cache/dvdst/rows`. An entry is
reused while the session file, the dvdst row logic, and the project rules are
unchanged, so a second query over the same sessions does not parse them again.
A session that is still growing is parsed each time.

```bash
dvdst cache            # directory, entry count, and size
dvdst cache --clear    # empty it
```

`--no-cache` skips the cache for one command. `DVDST_CACHE=off` turns it off,
and `DVDST_CACHE_DIR` moves it. `--full` rows and extractors always read the
session file.

### Add your own stream

A file in `.dvdst/extractors/` that default-exports `{ derive(session) }`
becomes a command with the same selection and format options. A script can
also import `loadSessions` from the library. See
[`docs/extractors.md`](extractors.md).

```bash
dvdst rows examples/extractors/failing-commands.mjs --project omakase-v2 --last 50
```

### Put `dvdst` on the path

The package declares a `dvdst` binary. Link it once to call it from any
directory:

```bash
npm link
dvdst --help
```

## 6b. Stage one session's changes

When a worktree carries several writers, stage only the changes one session
made. The command reads that session's live stream, or its Pi session file,
and replays its exact edits from HEAD. Unrelated dirty worktree hunks stay
unstaged. Unrelated staged changes block the whole operation. Writes are
allowed only for paths absent from HEAD.

```bash
npm run --silent dvdst -- stage \
  --input .dvdst/live/<session-id>.jsonl \
  --cwd /path/to/repository

npm run --silent dvdst -- stage \
  --session-file ~/.pi/agent/sessions/<project>/<session>.jsonl \
  --cwd /path/to/repository
```

Add `--dry-run` to check the plan without publishing index changes. Use
`--session <id>` to verify the source identity. `--cwd` selects a repository,
but relative mutation paths retain the recorded session directory. Other
repositories' paths are reported as excluded. Stage each repository separately.

The report includes `unattributedBash`, a heuristic warning list of successful
bash commands that look file-mutating. Inspect those warnings and the complete
staged diff before committing. Start a new session after committing. See
[`docs/live-streams.md`](live-streams.md) for transaction behavior and limits.

## 7. Ingest sessions into the evidence store

Ingest preserves the raw Pi session file and a manifest in a content-addressed snapshot. A repeated unchanged ingestion performs no writes.

```bash
npm run --silent dvdst -- ingest "$SESSION" --store .dvdst/store
```

The result line reports the session ID, source hash, and change class (`initial`, `append`, `replacement`, or `truncation`). Run the same command again to see `unchanged`.

Discover and ingest the whole corpus in one pipe:

```bash
npm run --silent dvdst -- sessions \
  "$HOME/.pi/agent/sessions/--home-a2ajinkya-Projects-omakase-v2--" \
  --format jsonl \
| npm run --silent dvdst -- ingest --store .dvdst/store
```

The stdin reader accepts JSON descriptors, plain paths, and TSV rows. It skips the TSV header row.

Ingest one live event stream the same way:

```bash
npm run --silent dvdst -- ingest --live .dvdst/live/<session-id>.jsonl --store .dvdst/store
```

See `docs/session-ingestion.md` for the store layout, change detection rules, and failure safety.

Normalize a stored session into derived records:

```bash
npm run --silent dvdst -- normalize "$SESSION" --store .dvdst/store
```

The command ingests the file if needed, then writes `records/entries.jsonl`, `messages.jsonl`, `tool-invocations.jsonl`, `tool-results.jsonl`, and `timeline.jsonl` plus `derived.json` into the snapshot. Payloads at or above 64 KiB move to `store/blobs/`. Re-running the command rewrites identical records. Orphan tool calls and results appear in the derived diagnostics.

Extract tool artifacts from the normalized records:

```bash
npm run --silent dvdst -- artifacts "$SESSION" --store .dvdst/store
```

The command ingests and normalizes if needed, then writes `artifacts/file-reads.jsonl`, `file-mutations.jsonl`, `searches.jsonl`, `commands.jsonl`, `tests.jsonl`, `bash-file-effects.jsonl`, and `unknown-tools.jsonl` plus `derived-artifacts.json` into the snapshot. Query them from the store:

```bash
npm run --silent dvdst -- files --store .dvdst/store --session <session-id> --format json
npm run --silent dvdst -- commands --store .dvdst/store --session <session-id> --class typecheck
```

Derive deterministic events and findings from the normalized artifacts:

```bash
npm run --silent dvdst -- events "$SESSION" --store .dvdst/store
```

The command ingests, normalizes, and extracts artifacts only if the snapshot
lacks them, then writes `events/deterministic.jsonl` and `derived-events.json`
into the snapshot. The stream contains `command-succeeded`, `command-failed`,
`file-read`, and `file-mutation` events plus derived findings
(`file-modified-without-observed-read`, `tests-not-run-after-final-mutation`,
`unresolved-command-failure`). Query them from the store with jq:

```bash
LATEST=$(jq -r .sourceHash .dvdst/store/sessions/pi/<session-id>/latest.json)
EV=".dvdst/store/sessions/pi/<session-id>/snapshots/$LATEST/events/deterministic.jsonl"
jq -c 'select(.kind == "finding-unresolved-command-failure")' "$EV"
jq -c 'select(.kind | startswith("finding")) | {kind, path, command}' "$EV"
```

See `docs/events.md` for the full event schema, the exact rules behind each
finding, and jq recipes for all of them.

## 8. Run the benchmark

The benchmark runs the probe and handoff against ten real Omakase cases and writes a markdown report.

```bash
node --import tsx scripts/run-benchmark.mjs
cat docs/benchmark-report.md
```

To add a new case, append it to `scripts/benchmark-cases.json`:

```json
{
  "id": "my-case",
  "session": "/abs/path/to/session.jsonl",
  "devlog": "/abs/path/to/devlog.md",
  "expected": {
    "status": "accepted",
    "phase": "docs-spine",
    "checkpoint": "name-of-checkpoint"
  }
}
```

Then re-run the benchmark. The status field uses the same values the devlog frontmatter uses: `accepted`, `closed`, `stable`, `user-testing`, `blocked`, `regressed`, or `planned`.

## 8b. Ingest the whole corpus

Run read-only ingestion against every session under a Pi session root:

```bash
npm run corpus -- ~/.pi/agent/sessions/--home-a2ajinkya-Projects-omakase-v2-- \
  --store .dvdst/store-corpus --report docs/corpus-report.json
```

The runner discovers sessions, ingests each into the store, classifies parse
diagnostics, verifies a sampled set of source files is unchanged, and writes an
aggregate report. A repeat run should report every session `unchanged`; do it on
quiesced sessions so a live, still-appending file is not misread. See
[`docs/release.md`](release.md) for the measured corpus run and the release
checks.

Remove the local store without touching the Pi sessions themselves:

```bash
npm run dvdst -- cleanup --store .dvdst/store --yes
```

Cleanup refuses to delete a directory without a `store.json` marker or without
`--yes`.

## 9. Run a one-off smoke test

The fixture under `test/fixtures/` makes it safe to test without touching real sessions.

```bash
npm run probe -- --session test/fixtures/skill-session.jsonl --devlog test/fixtures/skill-devlog.md --pretty | head -60
npm run handoff -- --session test/fixtures/skill-session.jsonl --devlog test/fixtures/skill-devlog.md
```

## 9. What each file does

| path | purpose |
| --- | --- |
| `src/pi/read-jsonl.ts` | streaming JSONL reader that records line and byte provenance |
| `src/pi/skill-block.ts` | parse explicit `/skill:name` blocks and extract a skill name from `SKILL.md` frontmatter |
| `src/pi/classify-commands.ts` | classify shell commands as test, typecheck, build, or lint |
| `src/pi/extract-commits.ts` | extract commit candidates from command output |
| `src/pi/normalize-paths.ts` | map absolute paths to project-relative paths |
| `src/pi/parse-devlog.ts` | parse Omakase devlog frontmatter |
| `src/pi/sessions.ts` | discover Pi session files in a directory |
| `src/normalize/normalize.ts` | normalize entries, messages, tools, and timeline into records |
| `src/artifacts/extract.ts` | extract file, command, search, and test artifacts from records |
| `src/skills/extract.ts` | detect skill invocations and attribute same-turn spans from normalized records |
| `src/events/extract.ts` | derive deterministic command, file, and finding records from artifacts |
| `src/store/ingest-session.ts` | stream Pi session files into content-addressed snapshots |
| `src/store/read-session.ts` | read a stored session snapshot and its manifest |
| `src/store/ingest-live.ts` | snapshot one live event stream |
| `src/store/read-live.ts` | read a stored live snapshot |
| `src/store/fs-util.ts` | atomic writes and path helpers for the store |
| `src/live/decompose.ts` | validate live events and emit observed evidence |
| `src/export/render.ts` | render evidence as markdown or CSV |
| `src/probe/build-bundle.ts` | build the full evidence bundle from a session and optional devlog |
| `src/handoff/summary.ts` | reduce the bundle to a compact handoff summary and text view |
| `src/devlog/format-devlog.ts` | map a handoff summary back to an Omakase devlog draft |
| `src/cli/probe.ts` | CLI for the full probe and JSONL streams |
| `src/cli/handoff.ts` | CLI for the compact summary |
| `src/cli/handoff-devlog.ts` | CLI for the devlog mapper |
| `src/cli/sessions.ts` | CLI to list Pi session files |
| `src/cli/records.ts` | CLI for files, commands, and skills streams |
| `src/cli/trace.ts` | CLI to look up the provenance of a single record |
| `src/cli/cleanup.ts` | CLI to remove a local evidence store after marker and confirmation checks |
| `src/cli/ingest.ts` | CLI to ingest session files or one live stream |
| `src/cli/normalize.ts` | CLI to normalize a stored session |
| `src/cli/artifacts.ts` | CLI to extract tool artifacts from a stored session |
| `src/cli/events.ts` | CLI to derive deterministic events and findings from a stored session |
| `src/cli/live.ts` | CLI to convert a live event stream to observed evidence |
| `src/cli/export.ts` | CLI to export evidence as markdown or CSV |
| `src/cli/timeline.ts` | CLI to read stored timeline evidence |
| `src/pi/resolve-sessions.ts` | resolve a file, id, prefix, or `latest` to session files |
| `src/pi/bash-effects.ts` | infer the files a bash command reads and mutates from its text |
| `src/config/config.ts` | load project command classes and ignored paths from `.dvdst/config.json` |
| `src/analysis/rows.ts` | derive overview, turns, calls, and context rows, and declare their schema |
| `src/sources/claude.ts` | convert a Claude Code transcript to the entry shape dvdst reads |
| `src/sources/read-session.ts` | detect the agent of a session file and read it |
| `src/analysis/cache.ts` | cache derived rows per session file |
| `src/analysis/session.ts` | load a session with its rows and project rules |
| `src/analysis/extractors.ts` | find and load project extractors |
| `src/index.ts` | library entry point |
| `src/cli/analysis.ts` | CLI for the row streams, project extractors, and `schema` |
| `skills/dvdst-session-analysis/` | agent skill for session analysis with the row commands |
| `examples/extractors/` | example extractors: orientation and failing commands |
| `src/cli/dvdst.ts` | dispatcher that routes every subcommand |
| `bin/dvdst.mjs` | launcher for the `dvdst` binary |
| `examples/pi-extension/dvdst-live.ts` | observe-only Pi extension that writes live events |
| `scripts/run-benchmark.mjs` | run all benchmark cases and write the report |
| `scripts/corpus-ingest.mjs` | read-only corpus ingestion, diagnostic classification, and resource measurement |
| `scripts/benchmark-cases.json` | list of real Omakase sessions used by the benchmark |
| `docs/benchmark-report.md` | latest benchmark output |
| `docs/cp0-benchmark.md` | narrative summary of the CP0 product proof |
| `docs/evidence-model.md` | storage and provenance design |
| `docs/live-streams.md` | live event contract and Pi extension adapter |
| `docs/session-ingestion.md` | session store design and commands |
