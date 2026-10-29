# divya-drushti (`dvdst`)

`dvdst` is a local evidence tool for coding agents: Pi, Claude Code, and Codex.
Query structured rows instead of spending context parsing entire transcripts.

## Agent quick start

Read [the agent guide](docs/agents.md) for session selection, command recipes,
JSON output, troubleshooting, and evidence limits. Agents opening this checkout
can start with [AGENTS.md](AGENTS.md). The reusable
[session-analysis skill](skills/dvdst-session-analysis/SKILL.md) works across
all three agents.

Node 22 or newer is required. For a fresh checkout:

```bash
git clone https://github.com/itama8/divya-drushti-dvdst.git dvdst
cd dvdst
npm ci --include=dev
node bin/dvdst.mjs schema calls
node bin/dvdst.mjs overview test/fixtures/claude-session.jsonl
```

Keep development dependencies installed: the CLI runs TypeScript using `tsx`.
There is no build step, API key, model service, or ingest prerequisite for
analysis. To query another project's sessions from this checkout:

```bash
node bin/dvdst.mjs overview --project my-project --source all --last 10
node bin/dvdst.mjs calls /absolute/path/to/session.jsonl --errors
node bin/dvdst.mjs handoff /absolute/path/to/session.jsonl --format json
```

Replace `my-project` and the session path with the target project and transcript.
From another working directory, use `node /absolute/path/to/dvdst/bin/dvdst.mjs`
with the same arguments. Optional: run `npm link` in this checkout to use `dvdst`.
Analysis defaults to Pi; choose `--source claude`, `--source codex`, or
`--source all` explicitly when discovering sessions. Prefer an exact transcript
path when examining a particular running agent; `latest` can select another
concurrent session.

## Source coverage

Use it to inspect session activity, compare tool use and token consumption,
prepare handoffs, and stage exact recorded edits in shared Git worktrees.
Support depends on the workflow:

| Workflow | Pi | Claude Code | Codex |
| --- | --- | --- | --- |
| Session analysis: `overview`, `turns`, `calls`, `context` | Supported | Supported, with missing source fields | Supported, with source limits |
| Direct inspection and closeout: `files`, `commands`, `skills`, `trace`, `probe`, `handoff`, `handoff-devlog` | Supported | Supported through transcript conversion | Supported through rollout conversion |
| Session-based Git staging | Supported | Supported | Supported for recorded patch formats |
| Stored session pipeline: `ingest`, `normalize`, `artifacts`, `events` | Supported | Supported | Supported |
| Bundled live recorder and settled review frames | Pi extension | No bundled adapter | No bundled adapter |

Claude Code does not record every Pi field. Cost and model generation timing
remain null where absent, and its `context` stream has no system prompt rows.
Codex also supports analysis, inspection, handoffs, and stored findings. Its
`turns` represent recorded assistant response items; recorded request usage is
attached once, with cost and request start times left null. Analysis reads the
supplied rollout segment; verified pagination joining remains staging-only.

## What dvdst does

**Analyze sessions without reading the whole transcript.** Query session,
model-request, tool-call, and context rows as JSONL, JSON, or TSV. Find failed
commands, repeated reads, retry runs, large tool results, file activity, token
use, and recorded cost. Pi, Claude Code, and Codex use the same row interface.
Project extractors and a TypeScript library support custom queries.

**Prepare evidence and handoffs.** Direct commands summarize files, commands,
skill loads, goals, and recorded commits for all three agents. The
store pipeline preserves content-addressed snapshots with provenance and
derives deterministic events and findings:

```text
ingest -> normalize -> artifacts -> skills -> events -> handoff
```

**Stage supported session edits.** Pi edits/writes, Claude Code Edit/Write
calls, and supported Codex `apply_patch` calls replay from HEAD into the Git
index. Explicit manifests select dependent changes across sessions. Staging
preserves unrelated unstaged work, refuses unrelated staged changes, and never
commits. Shell-written changes need independently reviewed Git staging.

**Observe Pi live activity.** The bundled Pi extension records lifecycle and
tool events. `live` derives observed evidence, and `review --watch` emits
inferred review frames after completed edits and a settled agent. A frame
routes evidence to a reviewer and does not perform code review itself.

The core runs locally with no model calls or network requests. Derived output
states its evidence and limits. See [capabilities and interfaces](docs/interfaces.md)
for command families, Omakase adapters, extension status, and unsupported paths.

## Use dvdst as an agent

### Query sessions as rows

Four commands read session files directly, with no ingest step, and write
JSONL: `overview` (one row per session), `turns` (one per canonical assistant
message, with recorded tokens and cost), `calls` (one per tool call joined to its result), and
`context` (one per system prompt section).

```bash
dvdst overview --project omakase-v2 --last 50 | jq -s 'sort_by(-.cost)[:5]'
dvdst calls latest --errors
dvdst schema calls
```

These commands read Pi, Claude Code, and Codex sessions. Select with
`--source pi|claude|codex|all`; the default remains Pi. For example:

```bash
dvdst overview --project dvdst --source all --last 20
dvdst calls latest --source codex --errors
```

A session is a file, a session id or id prefix, or `latest`. `dvdst schema`
prints every field. To add a stream, put a file that exports
`{ derive(session) }` in `.dvdst/extractors/`, or import `loadSessions` from
the library; see `docs/extractors.md`. Run `npm link` once to put `dvdst` on the path. See
section 6a of `docs/usage.md` for selection flags and recipes.

### Give an agent the skill

`skills/dvdst-session-analysis/` is a skill for Pi, Claude Code, and Codex. It tells an
agent which command answers which question, how to name sessions, and what
the rows do and do not support. Link it into the agent's skill directory:

```bash
mkdir -p ~/.pi/agent/skills ~/.claude/skills ~/.agents/skills
ln -s "$PWD/skills/dvdst-session-analysis" ~/.pi/agent/skills/
ln -s "$PWD/skills/dvdst-session-analysis" ~/.claude/skills/
# Codex:
ln -s "$PWD/skills/dvdst-session-analysis" ~/.agents/skills/
```

### Read canonical files directly

The store is plain JSONL on disk. You do not need the CLI to read it. This is
the contract:

```text
store/sessions/<pi|claude|codex>/<session-id>/snapshots/<source-hash>/
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

### Watch a live session for review

Start Pi with the observe-only extension, then watch its event stream in
another terminal:

```bash
pi -e ./examples/pi-extension/dvdst-live.ts
npm run --silent dvdst -- review --input .dvdst/live/<session-id>.jsonl --watch
```

When Pi settles after successful `edit` or `write` calls, `review` emits a
JSONL frame with the changed paths, failed commands, and whether a successful
test finished after the last mutation. These inferred frames help route work
to a reviewer. See [live streams](docs/live-streams.md#review-frames) for the
evidence limits and watcher behavior.

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

## Status

Release `0.1.0`. The ten-case benchmark matches every devlog status, and the
compact summary reduces source to about 1/100 to 1/1000 of its size. Corpus
ingestion covers 396 Omakase sessions with zero parse diagnostics.

Read the full release notes in `CHANGELOG.md` and the hardening details,
compatibility policy, and release checks in `docs/release.md`.

## Documentation

- [Agent guide](docs/agents.md) - setup, session selection, machine-readable workflows, and limits.
- [Capabilities and interfaces](docs/interfaces.md) - source support, commands, library, and Omakase integrations.
- `docs/usage.md` - command reference with real Omakase paths.
- `docs/extractors.md` - project extractors and the script library.
- `docs/events.md` - event and finding schema, and per-finding jq recipes.
- `docs/skills.md` - skill detection, attribution windows, and queries.
- `docs/cookbook.md` - tested jq recipes for evidence joins.
- `docs/session-ingestion.md` - the store, change detection, and failure safety.
- `docs/evidence-model.md` - the storage and provenance model.
- `docs/live-streams.md` - the live event contract and Pi extension adapter.
- `docs/session-staging.md` - Claude Code and Codex staging, pagination, and post-commit cursors.
- `docs/stage-manifests.md` - HEAD-pinned selection across sessions.
- `docs/cp0-benchmark.md` and `docs/benchmark-report.md` - product proof results.
- `docs/project-plan.md` - scope, checkpoints, and completion criteria.
- `docs/release.md` - corpus hardening, compatibility, and release checks.
