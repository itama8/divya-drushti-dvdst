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

## Context and cache rule

The evidence stream is not a replacement for the model context. It is a durable external record. A later context builder may select evidence and create a compact continuation prompt.

Keep the stable prompt prefix unchanged while a model uses prompt caching. Append a small, ordered evidence delta after that prefix. Do not rewrite a long historical summary on every event. A rewrite changes the cached prefix and can remove the cache benefit.

When a new compact context is needed, create it at a clear boundary, such as a settled turn, manual handoff, branch switch, or compaction. Store the selected evidence IDs and the context-builder version with that artifact. The artifact must state that it is reconstructed context, not source evidence.

## Limits

This path preserves producer order. It does not establish wall-clock order across two producers. It also does not replace the Pi session JSONL archive. Ingest the final session file when it is available to audit the live stream against Pi's persisted record.
