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
- `npm test` report 42 tests across 12 suites, all passing.

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

Look up the provenance of a specific record by its ID:

```bash
npm run dvdst -- trace "$SESSION" --id run-test
```

All four inspection commands support `--format json` for structured pipelines.

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

The command ingests and normalizes if needed, then writes `artifacts/file-reads.jsonl`, `file-mutations.jsonl`, `searches.jsonl`, `commands.jsonl`, `tests.jsonl`, and `unknown-tools.jsonl` plus `derived-artifacts.json` into the snapshot. Query them from the store:

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

The benchmark runs the probe and handoff against three real Omakase cases and writes a markdown report.

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
| `src/cli/ingest.ts` | CLI to ingest session files or one live stream |
| `src/cli/normalize.ts` | CLI to normalize a stored session |
| `src/cli/artifacts.ts` | CLI to extract tool artifacts from a stored session |
| `src/cli/events.ts` | CLI to derive deterministic events and findings from a stored session |
| `src/cli/live.ts` | CLI to convert a live event stream to observed evidence |
| `src/cli/export.ts` | CLI to export evidence as markdown or CSV |
| `src/cli/timeline.ts` | CLI to read stored timeline evidence |
| `src/cli/dvdst.ts` | dispatcher that routes every subcommand |
| `examples/pi-extension/dvdst-live.ts` | observe-only Pi extension that writes live events |
| `scripts/run-benchmark.mjs` | run all benchmark cases and write the report |
| `scripts/benchmark-cases.json` | list of real Omakase sessions used by the benchmark |
| `docs/benchmark-report.md` | latest benchmark output |
| `docs/cp0-benchmark.md` | narrative summary of the CP0 product proof |
| `docs/evidence-model.md` | storage and provenance design |
| `docs/live-streams.md` | live event contract and Pi extension adapter |
| `docs/session-ingestion.md` | session store design and commands |
