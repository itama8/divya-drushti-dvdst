---
name: dvdst-session-analysis
description: Use DVDST when looking back at Pi, Claude Code, or Codex sessions, for any purpose.
metadata:
  compatibility: Requires Node 22+ and a dvdst checkout with dependencies installed; reads Pi, Claude Code, and Codex files locally.
---

# dvdst session analysis

dvdst turns session files into rows: one JSON object per line, the same shape
for every session and all three agents. Start with focused rows before reading
raw transcripts. Inspect raw source only when a claim needs verification or an
unsupported format cannot answer the question. `jq` is optional for filtering.

Run `dvdst`. If it is not on the path, run `node <dvdst checkout>/bin/dvdst.mjs`
with the same arguments. It works from any directory and loads dependencies
from its checkout. If dependencies are missing, run `npm ci --include=dev`
inside that checkout with Node 22+. No build, model credentials, host extension,
or ingest step is required for analysis. For full setup and recipes, read
`docs/agents.md` in the DVDST checkout.

## 1. Pick the stream

| command | one row per | use it for |
| --- | --- | --- |
| `dvdst overview` | session | time, tokens, cost, tool totals, first prompt |
| `dvdst turns` | canonical assistant message | tokens, context size, cost, model, generation time |
| `dvdst calls` | tool call with its result | what ran, duration, exit code, result size, truncation, files read and changed, repeats |
| `dvdst context` | system prompt section | what the session started with, and its size |
| `dvdst messages` | canonical message | browse prompts/replies with bounded text and tool links |
| `dvdst search` | matching message/command/result | find earlier requests, corrections, decisions, or failures |

Run `dvdst schema calls` before you write a filter. It prints every field with
its type and meaning. Do not guess field names.

## 2. Pick the sessions

```bash
dvdst overview latest                          # newest session of this directory's project
dvdst calls 01a1180d                           # a session id or id prefix, from any agent
dvdst calls /path/to/session.jsonl             # a file
dvdst overview --last 50                       # the newest 50
dvdst overview --project omakase-v2 --since 2026-10-01
dvdst overview --project omakase-v2 --source claude
dvdst overview --project omakase-v2 --source all
dvdst calls latest --source codex --errors
```

With no session, the commands read `$PI_SESSION_FILE`, which is the current
session inside Pi. `latest`, `--last`, and `--since` select Pi sessions unless
you pass `--source claude`, `--source codex`, or `--source all`. `DVDST_SOURCE`
sets that default. Verify `overview.path`, `session`, and `firstPrompt` before
using a discovered transcript: `latest` can refer to another concurrent agent,
and discovery can fall back to other projects when the current cwd has none.
Prefer an exact path for a particular session. `--project <name>` constrains
project discovery; `--root <dir>` selects a flat transcript directory.

`--source` belongs to the analysis commands, not `handoff`, `files`, or store
commands. Pass those the exact transcript path returned by `overview`. The
standalone `sessions` filename discovery command remains Pi-only.

## 3. Ask the question

For conversation questions, search first, then expand the exact hit:

```bash
dvdst search /path/to/session.jsonl --query 'keep local Open' --role user --page
dvdst message --ref '<messageRef copied from the hit>' --before 2 --after 2
dvdst messages /path/to/session.jsonl --role user --limit 10
dvdst search /path/to/session.jsonl --query 'parser failed' --in results --limit 5
```

`messages` and `search` accept analysis session selection, `--fields`,
`--offset`, JSONL/JSON/TSV, and default to 20 rows with 240-character text slices.
Search is literal; add `--ignore-case` as needed. `--in` selects messages,
commands, results, or all. Explicit roles filter every target. `--page` returns
JSON counts, `nextOffset`, and failed-source metadata; partial queries still
exit nonzero. Row offsets are not snapshot cursors.

`message` returns the anchor and two neighbors per side by default (all roles,
including tools), with 2000 characters per message. Continue the anchor with
`--text-offset`, or use `beforeRef`/`afterRef` for more neighbors. `--limit` on
this reader bounds characters per message. Tool links lead to `call`;
`message --ref` also accepts call refs to show requesting context. Message
refs require unchanged raw file contents. Use `schema messages`, `schema search`,
and `schema message` for fields.

Start with `overview` to find the sessions that matter, then open `calls` or
`turns` for those. Every row carries `session`, so rows from many sessions can
go through one filter.

```bash
# the most expensive sessions
dvdst overview --last 50 | jq -s 'sort_by(-.cost)[:5][] | {session, cost, turns, calls, firstPrompt}'

# what failed in one session
dvdst calls latest --errors | jq -c '{seq, tool, exitCode, durationMs, command, path}'

# where the time went
dvdst calls latest | jq -s 'sort_by(-.durationMs)[:10][] | {seq, tool, durationMs, command, path}'

# files read past the agent's output limit, across sessions
dvdst calls --last 50 | jq -r 'select(.truncated) | .reads[]' | sort | uniq -c | sort -rn | head

# context growth across one session
dvdst turns latest | jq -c '{turn, contextTokens, outputTokens, calls}'

# what kind of bash work a project does: group by program, not by your own regex
dvdst calls --last 50 --tool bash | jq -r '.verbs[]' | sort | uniq -c | sort -rn | head -20

# the same failing command run again and again
dvdst calls --last 50 --errors | jq -c 'select(.commandAttempt >= 3) | {session, seq, commandAttempt, failureRun, command}'

# files read again with nothing changed in between
dvdst calls --last 50 | jq -r '.rereads[]' | sort | uniq -c | sort -rn | head
```

Use the fields the rows already carry before you write a pattern over
`command`: `verbs` names the programs a bash call runs, `classes` groups them
(`test`, `build`, `typecheck`, `inline-script`, and the project's own),
`rereads` marks repeated reads, and `commandAttempt` and `failureRun` count
repeats and consecutive failures. `overview` totals them per session.

Rows are cached per session; rerun focused queries as needed. `--no-cache`
bypasses caching for one analysis command.

`calls` takes `--tool <name>`, `--errors`, `--class <name>`, `--id <callId>`,
and `--seq <n>`. Built-in streams accept `--fields`, `--limit` (rows), and
`--offset`, applied after filtering across selected segments. Keep source
identity and references when projecting fields. Expand individual calls:

```bash
dvdst calls /path/to/session.jsonl --class test --limit 10 --fields session,seq,line,isError,ref
dvdst call /path/to/session.jsonl --seq 42 --limit 2000
dvdst call --ref '<ref copied from calls>' --limit 2000
dvdst schema call
```

`call` returns JSON with call metadata and separate `command`, `args`
(serialized JSON), and `result` slices. Each slice reports `nextOffset` and
`truncated`. Continue with `--result-offset`, `--args-offset`, or
`--command-offset`. The default limit is 4096 Unicode code points per field;
maximum 65536. Missing results are null. References pin an exact file and raw
snapshot; any append/change requires refreshing `calls`. Row offsets are not
snapshot cursors. `--full` remains available for bulk payload analysis, and
payload field projection requires it. See `docs/evidence-retrieval.md`.

For a machine-readable closeout, run `dvdst handoff <session> --format json`.
For stored findings, `dvdst events <session> --store <directory>` prints a
snapshot descriptor; findings are in `<snapshot>/events/deterministic.jsonl`.
Staging is a separate optional index mutation workflow. Consult
`docs/session-staging.md` in the checkout before using it; normal reviewed Git
staging is also supported. Analysis does not require staging.

## 4. When no stream answers it

Write an extractor instead of a one-off script. Put a file in
`.dvdst/extractors/` that default-exports `{ derive(session) }`, and it becomes
`dvdst <name>` with the same session selection and formats. `derive` receives
the parsed session: `overview`, `turns`, `calls` with arguments and result
text, `context`, and the raw `records`. Add `summarize(rows)` to rank or count
across sessions. The dvdst checkout documents this in `docs/extractors.md` and
has two complete extractors in `examples/extractors/`.

## 5. Report what the rows support

- `reads` and `mutates` of a bash call are inferred from the command text.
  `opaque` lists the reasons a call may change files it does not name. Say so
  when a claim rests on them.
- `durationMs` of Pi calls made in one message is an upper bound.
- A Claude Code session has no cost, no request start time, and no system
  prompt. Those fields are null. Do not report null as zero.
- Codex turns are recorded assistant items, not guaranteed provider request
  counts. Usage is attached once where recorded; cost and request start times
  remain null. Analysis covers the supplied rollout segment. Complex exec
  scripts remain opaque; supported literal batches expose their nested tools.
- An incomplete line in a growing transcript may make that file fail. Analysis
  can emit rows for other sessions and still exit nonzero; inspect stderr and
  do not treat partial output as complete. Retry after the file settles.
- Cite the `session` and `line` of the rows behind a finding, so a reader can
  check it against the session file.
- Search on merged Claude text cites the matched block; its message's first
  line may be earlier. Codex `channel` distinguishes analysis from final or
  commentary replies. Thinking/reasoning blocks and binary content are not
  substituted for conversation text. Recorded statements alone do not prove
  implementation or acceptance.
- Handoff `validation` distinguishes unfinished tests, exact-argument retries,
  and tests dispatched after the last potential mutation settled. Historical
  failures stay counted after retry. Parallel edit/test calls do not prove
  ordering. `stable` describes validation evidence, not correctness or acceptance.
