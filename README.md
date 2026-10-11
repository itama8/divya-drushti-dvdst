# divya-drushti (`dvdst`)

`dvdst` turns coding-agent sessions into structured development evidence.

A coding session is a long JSONL transcript. To answer "which files changed,
which commands failed, which skills ran", you first read the whole session
back into context. dvdst ingests the session once. After that, you and
other agents query narrow, verifiable facts without rereading it.

## What dvdst does

dvdst copies a Pi session into a local evidence store, then derives streams
from it:

- messages, tool calls, and tool results, each with line-level provenance
- file reads and mutations, with observed versus reconstructed patches
- shell commands and their outcomes, classified by command type
- skill invocations and the records a skill may have influenced
- deterministic events: command success, command failure, file activity
- findings: a file changed without a prior read, final changes never re-run
  through tests, command failures never retried to success
- a compact handoff summary for closeout, without generating prose

The pipeline is one command:

```text
ingest -> normalize -> artifacts -> skills -> events -> handoff
```

Every step is deterministic, local, and dependency-free. It makes no model
calls and no network requests. Re-running an extractor writes byte-identical
output and never changes the raw snapshot it copied.

## Install and try it

```bash
npm install
npm test
```

Node 22 or newer. The examples in this readme use the Omakase session corpus,
but the commands work on any Pi session file.

```bash
npm run --silent dvdst -- events /path/to/session.jsonl --store .dvdst/store
```

This one command ingests, normalizes, extracts artifacts, and derives events.
To read store-generated streams later, use the store forms of the commands,
which accept `--store` and `--session` (see `docs/usage.md`).

## Use dvdst as a human

### Investigate one session

These examples use `$SESSION` as the path to a session file.

```bash
npm run dvdst -- files    "$SESSION"                     # what was read and mutated
npm run dvdst -- commands "$SESSION" --class test        # test commands only
npm run dvdst -- skills   "$SESSION"                     # skill invocations and span lines
npm run dvdst -- trace    "$SESSION" --id <record-id>    # provenance of one record
```

### Close out a session

```bash
npm run dvdst -- handoff "$SESSION" --devlog .devlog/2026-08-04.md
npm run dvdst -- handoff-devlog "$SESSION" --out draft.md --project omakase-v2
```

The handoff summary reports goals, touched files, commands, tests, skills,
commits, and unresolved work. A summary of a 687 KB session is about 1.6 KB,
with source-line references for every claim. A maintainer verifies claims
without rereading the transcript.

### Run the benchmark or ingest the corpus

```bash
node --import tsx scripts/run-benchmark.mjs
npm run corpus -- ~/.pi/agent/sessions/--home-a2ajinkya-Projects-omakase-v2-- \
  --store .dvdst/store-corpus
npm run dvdst -- cleanup --store .dvdst/store --yes
```

The benchmark runs ten real Omakase sessions and writes the report. The corpus
command ingests every session under a root, read-only. Cleanup removes the
local store. It never touches the Pi sessions.

## Use dvdst as an agent

### Query sessions as rows

Four commands read session files directly, with no ingest step, and write
JSONL: `overview` (one row per session), `turns` (one per model request, with
tokens and cost), `calls` (one per tool call joined to its result), and
`context` (one per system prompt section).

```bash
dvdst overview --project omakase-v2 --last 50 | jq -s 'sort_by(-.cost)[:5]'
dvdst calls latest --errors
dvdst schema calls
```

A session is a file, a session id or id prefix, or `latest`. `dvdst schema`
prints every field. Run `npm link` once to put `dvdst` on the path. See
section 6a of `docs/usage.md` for selection flags and recipes.

### Read canonical files directly

The store is plain JSONL on disk. You do not need the CLI to read it. This is
the contract:

```text
store/sessions/pi/<session-id>/snapshots/<source-hash>/
├── source/raw.jsonl               verbatim snapshot the streams point back to
├── records/                       entries, messages, tool calls, timeline,
│                                  skill invocations and attributions
├── artifacts/                     file reads, mutations, commands, tests
└── events/deterministic.jsonl     events and findings, in source order
```

Each record carries a `confidence` value (`observed`, `reconstructed`,
`inferred`) and a `source` reference to a line and byte range in the raw
snapshot. No record pretends an absence is a fact, and no record pretends
reconstruction is observation.

### Pipe JSONL through stdout

Commands write one JSON object per line on stdout and diagnostics on stderr.
This makes discovery and ingestion composable:

```bash
npm run --silent dvdst -- sessions <root> --format jsonl \
  | npm run --silent dvdst -- ingest --store .dvdst/store
```

### Join streams with jq

Attributions and commands share a tool-call id. This join reports every
command that ran inside a skill span:

```bash
jq -n --slurpfile a "$BASE/records/skill-attributions.jsonl" \
      --slurpfile c "$BASE/artifacts/commands.jsonl" \
 '($a[] | select(.recordKind=="tool-call")) as $at
  | ($c[] | select(.toolCallId==$at.recordId)) as $cmd
  | {command: $cmd.command, failed: $cmd.result.isError, skills: [$at.labels[].invocationId]}'
```

The jq cookbook in `docs/cookbook.md` covers skill versions by content hash,
attributed tool use, validation, failures, and per-session outcomes. Each
recipe's output is asserted by a test, so the recipes do not drift from the
extractors.

## Status

Release `0.1.0`. The ten-case benchmark matches every devlog status, and the
compact summary reduces source to about 1/100 to 1/1000 of its size. Corpus
ingestion covers 396 Omakase sessions with zero parse diagnostics.

Read the full release notes in `CHANGELOG.md` and the hardening details,
compatibility policy, and release checks in `docs/release.md`.

## Documentation

- `docs/usage.md` - command reference with real Omakase paths.
- `docs/events.md` - event and finding schema, and per-finding jq recipes.
- `docs/skills.md` - skill detection, attribution windows, and queries.
- `docs/cookbook.md` - tested jq recipes for evidence joins.
- `docs/session-ingestion.md` - the store, change detection, and failure safety.
- `docs/evidence-model.md` - the storage and provenance model.
- `docs/live-streams.md` - the live event contract and Pi extension adapter.
- `docs/cp0-benchmark.md` and `docs/benchmark-report.md` - product proof results.
- `docs/project-plan.md` - scope, checkpoints, and completion criteria.
- `docs/release.md` - corpus hardening, compatibility, and release checks.
