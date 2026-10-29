# divya-drushti (`dvdst`)

Give your coding agent a way to look back at its work.

## What DVDST does

DVDST helps your agent make sense of coding sessions from **Pi, Claude Code,
and Codex**. It turns long session logs into focused answers about what the
agent did, what commands returned, and where time and context went.

With it, you can ask your agent to:

- **Pick up earlier work.** “What were we doing, which files were involved,
  and where should we continue?” Your agent can prepare a compact handoff
  instead of bringing the whole conversation into its context.
- **Find wasted effort.** “Why did this take so long?” It can look for repeated
  file reads, command retries, large tool outputs, and token use across sessions.
- **Explain what happened.** “What commands did we run, which failed, and what
  did we test?” It can inspect recorded results and point back to the session
  lines behind its answer.

You stay in the conversation with your agent. It uses DVDST to fetch the
relevant evidence, brings back a smaller answer, and continues working.
Session analysis runs locally on your existing logs.

**Prepare a focused commit.** *Optional—when you ask for it.* “Stage these edits
without sweeping in the other agent's work.” For supported edit formats, DVDST
can replay selected changes into Git's staging area while leaving unrelated
unstaged work alone. Your agent still reviews the diff and handles the commit.

## Give the link to your agent

Copy this into Pi, Claude Code, or Codex:

> Read https://github.com/itama8/divya-drushti-dvdst and set up DVDST for this
> project. Use its agent guide to find our recent coding sessions, then tell
> me what we worked on and which recorded commands failed. Show the sources
> behind your answer.

After that, ask things like “help me hand this work to a fresh agent” or
“look across our recent sessions for repeated work.” The agent can use the
same tool as part of its normal coding workflow.

## Experimental, and already useful

We use DVDST in our own work, and we're sharing it while it is still evolving.
In one investigation, we used it to compare 30 coding sessions: how much context
our agents were carrying, which files they kept reading, and which commands they
kept retrying. That let us examine patterns across sessions instead of reading
each conversation from start to finish.

We've also used it to prepare compact handoffs for release audits and select
edits from several sessions in shared worktrees. Project-specific review
workflows have used its evidence to give a second agent context for a review.

The query and staging tools are included here; the project-specific reviewer
orchestration lives in those projects. Support varies by agent and workflow;
the details are below. Recorded evidence still needs interpretation, especially
around incomplete sessions.

Next up:

- [ ] Make handoffs distinguish successful, failed, and unfinished work more clearly.
- [ ] Keep stored snapshots consistent when a session is still being written.
- [ ] Make setup and release checks easier to repeat on a fresh machine.

**Privacy:** DVDST processes session logs locally and does not upload them.
When your agent reads the resulting evidence, that content may be sent to its
model provider under your agent's settings. Session logs can contain code,
commands, and other project information.

---

## For agents: setup and first query

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

All three agents support analysis, inspection, handoffs, stored evidence, and
supported session edits. Live recording and settled review frames currently
come from the Pi extension:

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

## For agents: queries and skills

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
- `docs/cp0-benchmark.md` and `docs/benchmark-report.md` - historical Pi benchmark results.
- `docs/project-plan.md` - scope, checkpoints, and completion criteria.
- `docs/release.md` - corpus hardening, compatibility, and release checks.

---

**दिव्यदृष्टी · Divya Drushti**

*Marathi, noun.* “Divine vision”: the ability to perceive what is beyond ordinary
sight; clairvoyance. ([Marathi dictionary](https://www.transliteral.org/dictionary/दिव्यदृष्टी/word))
