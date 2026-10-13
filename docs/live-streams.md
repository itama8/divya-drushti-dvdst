# Live streams

## Goal

`dvdst live` converts an append-only event stream into observed evidence while a Pi session runs. The command does not wait for the Pi JSONL session file to close.

The first live path records source facts. It does not infer decisions or generate a handoff. Later extractors can read the same evidence after the session ends.

## Event contract

Send one JSON object per line. A producer must serialize events for one `source` and `sessionId` pair. It must assign a strictly increasing `sequence` number. Do not reuse an `eventId`.

```json
{"schemaVersion":1,"source":"pi.extension","sessionId":"session-1","sequence":0,"observedAt":"2026-03-13T10:00:00.000Z","type":"tool.started","data":{"toolCallId":"call-1","toolName":"bash","args":{"command":"npm test"}}}
```

Required fields:

- `schemaVersion`: `1`
- `source`: the producer name
- `sessionId`: the producer session identifier
- `sequence`: a non-negative integer
- `observedAt`: an ISO timestamp supplied by the producer
- `type`: the event type
- `data`: the producer payload

`eventId` is optional. If it is absent, `dvdst` derives it from `source`, `sessionId`, and `sequence`.

`dvdst` rejects a duplicate event ID or a sequence that does not increase. This makes a replay or a producer restart visible. It does not silently alter the timeline.

## Run it

Read from stdin:

```bash
producer | npm run dvdst -- live > evidence.jsonl
```

Read a persisted stream:

```bash
npm run dvdst -- live --input .dvdst/live/<session-id>.jsonl > evidence.jsonl
```

Each output line is an immutable record with `confidence: "observed"`. Its provenance includes the input line, source, and event ID.

## Export for people

`dvdst export` reads evidence JSONL. It writes one Markdown timeline or CSV table to stdout. It does not add a summary or infer a decision.

```bash
npm run --silent dvdst -- live --input .dvdst/live/<session-id>.jsonl \
  | npm run --silent dvdst -- export --format markdown > session.md

npm run --silent dvdst -- live --input .dvdst/live/<session-id>.jsonl \
  | npm run --silent dvdst -- export --format csv > session.csv
```

Markdown includes the observed time, evidence ID, confidence, and readable message or tool content. CSV has one row per evidence record. Its `data` column contains the original event payload as JSON. Both formats retain the event source and ID.

## Store a snapshot

`dvdst ingest` preserves one source and session in the local evidence store. It keeps the raw event stream and the normalized timeline in a content-addressed snapshot.

```bash
npm run --silent dvdst -- ingest \
  --live .dvdst/live/<session-id>.jsonl \
  --store .dvdst/store
```

The command writes the snapshot under `sessions/live/<source>/<session-id>/snapshots/<sha256>/`. It updates `latest.json` for that source session. If the source bytes have not changed, it reports `unchanged` and does not write a duplicate snapshot.

Read the latest stored timeline without reopening the source file:

```bash
npm run --silent dvdst -- timeline \
  --store .dvdst/store \
  --source pi.extension \
  --session <session-id>

npm run --silent dvdst -- timeline \
  --store .dvdst/store \
  --source pi.extension \
  --session <session-id> \
  --kind tool.finished
```

Export the same latest snapshot:

```bash
npm run --silent dvdst -- export \
  --store .dvdst/store \
  --source pi.extension \
  --session <session-id> \
  --format markdown > session.md
```

Pass `--snapshot <sha256>` to `timeline` or `export` to read a prior snapshot instead of `latest.json`.

## Pi adapter

`examples/pi-extension/dvdst-live.ts` is an observe-only Pi extension. It writes `.dvdst/live/<session-id>.jsonl` by default. Set `DVDST_LIVE_DIR` to use another local directory.

The adapter observes these Pi lifecycle events:

- session start and shutdown
- finalized messages
- tool start, update, and finish
- compaction
- branch selection

The extension only writes a local append-only file. It does not add a Pi message, modify a tool call or result, change the provider request, or replace Pi compaction.

Use it with Pi during development:

```bash
pi -e ./examples/pi-extension/dvdst-live.ts
```

Process the stream during or after the session:

```bash
npm run dvdst -- live --input .dvdst/live/<session-id>.jsonl
```

## Stage a session's changes

For dependent work across sessions, use an [explicit staging manifest](stage-manifests.md).
It selects exact successful calls in replay order and pins HEAD. The rules below also apply to manifest staging.

`dvdst stage` reads one append-only stream, Pi session file, Claude transcript, or Codex rollout. It replays
successful exact edits from HEAD, then compares complete replay states with
the index. All edits in one tool call match the same original content.
Unrelated dirty worktree hunks stay unstaged. The command does not change the
worktree or commit.

```bash
npm run --silent dvdst -- stage \
  --input .dvdst/live/<session-id>.jsonl \
  --cwd /path/to/repository

npm run --silent dvdst -- stage \
  --session-file ~/.pi/agent/sessions/<project>/<session>.jsonl \
  --cwd /path/to/repository
```

The command prints one JSON record with `staged`, `unchanged`, `conflicts`, and
`excluded` arrays. Exit code 1 means a conflict blocked the entire operation.
Exit code 2 means input, Git, or execution failed. Neither failure publishes a
partially prepared index. A repeated run compares the full result with the
index and reports matching paths as `unchanged`, including chained edits and
deletions. An earlier complete replay state can advance to a later state.

`--cwd` selects the repository. Relative mutation paths resolve from the
recorded session directory, not the selected repository. Paths outside that
repository appear in `excluded` and are skipped. Run the command separately
for each repository edited by the session. `--session <id>` verifies the
source identity. It does not relabel or filter a mixed-session source.

Unrelated staged changes block the operation, even on another path. The
command does not clear them. Inspect the index and preserve their ownership
before retrying. A successful run prepares a private index under Git's normal
index lock, then publishes it with one rename. `--dry-run` performs the same
checks without publishing. It also requires the index lock.

Successful bash commands that look file-mutating are listed in
`unattributedBash` with the signals that matched, such as `heredoc`, `redirect`,
or `git apply or patch`. They are warnings, not path attributions, and they are
never staged. Check the list before committing.

Limits:

- Writes are allowed only for paths absent from HEAD. The entire recorded
  payload becomes the staged file. This does not prove who first created an
  untracked file. Writes to tracked files conflict because no pre-image proves
  ownership. Use exact edits instead.
- Missing, duplicate, or overlapping anchors conflict. Fuzzy edits are not
  reconstructed. An edit to an untracked file requires an earlier recorded
  write in this session.
- Mixed-session live streams, duplicate events, malformed session JSON, and
  invalid successful mutation evidence fail instead of being silently dropped.
- Forked session files contain inherited tool calls and are refused. A live
  stream recorded for the new session can still be used.
- Unmerged entries, symlinks, submodules, binary blobs, and invalid UTF-8 content
  are not supported. These paths conflict instead of being rewritten.
- After committing, start a new session, select later calls in a fresh manifest,
  or use a verified `--after <last-committed-result-event-id>` cursor. Old full-session replay against a changed HEAD is not supported. No persistent staging receipt exists.
- Bash changes are not attributed. The warning detector can miss helper-script
  writes. Recorded tool results do not prove that their changes still exist in
  the worktree. Inspect the complete staged diff before committing.
- A normal cancellation releases the lock before publication. A killed process
  can leave `index.lock`, as Git can. Inspect the repository and confirm no
  writer remains before removing a stale lock.

## Context and cache rule

The evidence stream is not a replacement for the model context. It is a durable external record. A later context builder may select evidence and create a compact continuation prompt.

Keep the stable prompt prefix unchanged while a model uses prompt caching. Append a small, ordered evidence delta after that prefix. Do not rewrite a long historical summary on every event. A rewrite changes the cached prefix and can remove the cache benefit.

When a new compact context is needed, create it at a clear boundary, such as a settled turn, manual handoff, branch switch, or compaction. Store the selected evidence IDs and the context-builder version with that artifact. The artifact must state that it is reconstructed context, not source evidence.

## Limits

This path preserves producer order. It does not establish wall-clock order across two producers. It also does not replace the Pi session JSONL archive. Ingest the final session file when it is available to audit the live stream against Pi's persisted record.
