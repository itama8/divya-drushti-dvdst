# Agent guide

Use DVDST to answer questions about coding-agent sessions with compact,
structured evidence. The same row interface supports Pi, Claude Code, and Codex.
The core runs locally without model calls or network requests.

## Setup and first query

For a fresh checkout, with Node 22 or newer:

```bash
git clone https://github.com/itama8/divya-drushti-dvdst.git dvdst
cd dvdst
npm ci --include=dev
node bin/dvdst.mjs schema calls
node bin/dvdst.mjs overview test/fixtures/claude-session.jsonl
```

For an existing checkout, `cd /absolute/path/to/dvdst` and run
`npm ci --include=dev`. Keep `tsx` installed; it is currently a development
dependency required by the CLI. There is no build step. Analysis does not need
an ingest step. `jq` is optional and used in the filtering examples below.

Run `npm link` from the DVDST checkout to expose `dvdst`, or invoke
`node /absolute/path/to/dvdst/bin/dvdst.mjs` with the same arguments from any
working directory. The examples below use the linked `dvdst` command.
The binary retains your working directory for project selection and loads
its dependencies from the DVDST checkout.

The reusable [session-analysis skill](../skills/dvdst-session-analysis/SKILL.md)
contains the query workflow and source limits. Link that folder into the host's
skill directory if desired; [README](../README.md#give-an-agent-the-skill) shows
Pi, Claude Code, and Codex examples. Hosts may require a reload or a new session
before discovering a newly linked skill. You can also read the skill directly;
no host extension or skill installation is required to run the CLI.

## Select the intended session

An exact transcript path is the most reliable selection for a particular agent.
The file's contents identify its source; no `--source` flag is required.

```bash
dvdst overview /absolute/path/to/session.jsonl
dvdst calls /absolute/path/to/session.jsonl --errors
```

For discovery, run these from the project being investigated, or add
`--project <project-directory-name>`:

```bash
dvdst overview latest --source pi
dvdst overview latest --source claude
dvdst overview latest --source codex
dvdst overview --source all --last 10
dvdst overview --project my-project --source all --since 2026-10-01
```

`latest`, `--last`, and `--since` default to Pi unless `--source` or
`DVDST_SOURCE` selects another source. No-argument analysis uses
`PI_SESSION_FILE` if set; it does not automatically identify a current Claude
or Codex conversation. `latest` means newest matching start time, and can name
another concurrent agent. Inspect `overview.path`, `session`, and `firstPrompt`
before relying on a discovered session. With no matching cwd, discovery can
fall back to other projects; use `--project` or an exact file to constrain it.

Default roots:

- Pi: `~/.pi/agent/sessions/<encoded-project>/`.
- Claude Code: `~/.claude/projects/<encoded-project>/` (main transcripts).
- Codex: `$CODEX_HOME/sessions`, default `~/.codex/sessions`, including date
  directories. Project selection uses recorded cwd.

A full session ID or unambiguous prefix can resolve across agents when no
source/project/root constraint is supplied. `--root <directory>` selects a
flat directory of JSONL files for analysis. It does not recursively scan an
arbitrary archive. `DVDST_SESSION_ROOT` also overrides the default root.
The separate `sessions <directory>` command recognizes Pi filenames only.

Source selection flags belong to analysis commands (`overview`, `turns`,
`calls`, `context`, and project extractors). For `handoff`, `files`, or stored
commands, pass the exact path returned by `overview`; those commands do not
accept `--source`. For example, after verifying the overview:

```bash
SESSION=$(dvdst overview latest --source codex | jq -r .path)
dvdst handoff "$SESSION" --format json
```

## Choose the smallest useful query

| Question | Command | Output |
| --- | --- | --- |
| Which sessions matter? | `dvdst overview --source all --last 10` | One row per session |
| What failed? | `dvdst calls "$SESSION" --errors` | Calls joined to recorded results |
| What commands/tests ran? | `dvdst commands "$SESSION" --class test --format json` | Command evidence |
| What did it read/change? | `dvdst calls "$SESSION"` | `reads`, `mutates`, `opaque`, outcomes |
| What is in a field? | `dvdst schema calls` | Field types and meanings |
| Where did tokens go? | `dvdst turns "$SESSION"` | Canonical assistant messages with recorded usage |
| What context was recorded? | `dvdst context "$SESSION"` | Recorded system sections |
| What should the next agent know? | `dvdst handoff "$SESSION" --format json` | Compact goals, files, commands, tests, commits |
| Where did this claim come from? | `dvdst trace "$SESSION" --id <record-id> --format json` | Available provenance/attributions |
| Need custom analysis? | `dvdst rows <extractor-file> "$SESSION"` | Project-defined rows |

Read a schema before composing filters. Analysis output defaults to JSONL;
`--format json` produces an array, and `--format tsv` is available. `--full`
adds arguments and result text, which can be large:

```bash
dvdst schema calls --format json
dvdst calls "$SESSION" --errors --full \
  | jq -c '{session, line, callId, tool, exitCode, command, resultText}'
dvdst calls "$SESSION" \
  | jq -c 'select((.mutates | length) > 0) | {session, line, mutates, isError}'
```

`calls` file effects include inferred shell reads/writes. Direct `files` and
handoff summaries include explicit file tools and Codex patch paths; they do
not enumerate every shell file effect. Skill attribution describes evidence
associations, not proof that the agent followed a skill.

Analysis caches derived rows automatically. Use `--no-cache` for one query or
`DVDST_CACHE=off` to disable caching. Library/extractor users can start with
`loadSessions`; see [extractors](extractors.md).

## Stored findings and optional staging

For persisted evidence and deterministic findings:

```bash
dvdst events "$SESSION" --store .dvdst/store
```

This ingests a verbatim snapshot, normalizes records, extracts artifacts, and
writes events/findings. Stdout contains a result descriptor with `snapshot`,
not the event rows themselves. Read `<snapshot>/events/deterministic.jsonl` for
the findings. Snapshots live under
`store/sessions/<pi|claude|codex>/<session-id>/snapshots/<source-hash>/`.
Store commands with `--session <id>` refuse an ID shared by multiple agents;
`--snapshot <hash>` can select a unique snapshot. See
[session ingestion](session-ingestion.md) and [findings](events.md).

Staging is an optional index mutation workflow. It replays supported edits from
HEAD, never commits, and does not attribute arbitrary shell writes:

```bash
dvdst session-stage --agent codex --session-file "$SESSION" --list
dvdst session-stage --agent codex --session-file "$SESSION" --cwd /path/to/repo --dry-run
```

Use `--agent claude` for Claude Code. Follow
[session staging](session-staging.md) and [manifests](stage-manifests.md) before
publishing changes to the index. Ordinary reviewed Git staging is also valid.
The bundled live recorder and settled review frames remain Pi-only; no bundled
Claude/Codex live adapter or model reviewer is installed by DVDST.

## Interpret evidence and recover from errors

- Cite `session` and source `line` for row-based claims. Stored records also
  preserve byte ranges into their verbatim source snapshot.
- Null cost, time, or outcome is unknown, not zero or successful. Findings are
  derived evidence; they do not establish correctness or product acceptance.
- Claude omits cost, request start times, and system prompt sections. Main
  transcript conversion excludes sidechain entries.
- Codex turns are recorded assistant response items, not guaranteed provider
  request counts. Recorded request usage is attached once. Base instructions
  are the available system context. Native shell calls and supported literal
  exec batches expose commands; arbitrary scripts remain opaque. A running
  native shell call remains unfinished until a recorded poll supplies its exit.
- Codex analysis/ingestion covers the supplied segment. It does not reconstruct
  fork ancestry or join paginated history. Staging has a separate verified
  pagination loader. See [source coverage](interfaces.md).
- Diagnostics go to stderr. Analysis may emit successful session rows and still
  exit nonzero when another selected file fails, including an incomplete JSONL
  line in a growing transcript. Inspect stderr; retry a settled file or query an
  exact completed transcript. Do not silently treat partial output as complete.
- If no session matches, check `--source`, project, root, and exact path. Do not
  guess a transcript identity from the current agent's name alone.
- If `tsx` cannot be resolved, run `npm ci --include=dev` in the DVDST checkout.
  If `dvdst` is not found, use the absolute `bin/dvdst.mjs` invocation above.
