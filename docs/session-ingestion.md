# Session ingestion

## Goal

`dvdst ingest` preserves Pi session files in the local evidence store before any normalization runs. A snapshot keeps the raw source, a source-state summary, and a manifest. Repeated unchanged ingestion performs no writes.

This is the file-based counterpart to the live event stream in `docs/live-streams.md`. Live ingestion preserves what a Pi extension observed while the session ran. Session ingestion preserves the final Pi JSONL archive. Use the archive to audit the live stream after the session ends.

## Run it

Ingest one or more session files:

```bash
npm run --silent dvdst -- ingest \
  ~/.pi/agent/sessions/--home-a2ajinkya-Projects-omakase-v2--/*.jsonl \
  --store .dvdst/store
```

The command writes one result JSONL per file. It prints diagnostics to stderr and exits nonzero when any file fails.

Discover then ingest in one pipe:

```bash
npm run --silent dvdst -- sessions \
  ~/.pi/agent/sessions/--home-a2ajinkya-Projects-omakase-v2-- \
  --format jsonl \
| npm run --silent dvdst -- ingest --store .dvdst/store
```

The stdin reader accepts JSON descriptors, plain paths, and TSV rows from `dvdst sessions --format tsv`. It skips the TSV header row.

Ingest one live stream:

```bash
npm run --silent dvdst -- ingest \
  --live .dvdst/live/<session-id>.jsonl \
  --store .dvdst/store
```

`--store` defaults to `.dvdst/store`.

## Store layout

```text
store/
├── store.json
└── sessions/
    └── pi/<session-id>/
        ├── latest.json
        └── snapshots/<sha256>/
            ├── manifest.json
            └── source/
                ├── raw.jsonl
                └── source-state.json
```

The snapshot name is the SHA-256 of the whole source file. Equal content always maps to one snapshot. `latest.json` records the most recently ingested snapshot for the session.

Read the latest snapshot back without reopening the source file:

```bash
npm run --silent dvdst -- timeline \
  --store .dvdst/store --source pi.extension --session <session-id>
```

Session snapshots share the store layout with live snapshots. The session directory differs by adapter segment: `sessions/pi/<session-id>/` for files versus `sessions/live/<source>/<session-id>/` for live streams.

## Change classes

The manifest and the ingest result record one change class for each snapshot:

- `initial`: the first snapshot for the session
- `append`: the new source keeps the previous bytes and adds trailing lines
- `replacement`: an earlier line changed or the prefix hash does not match
- `truncation`: the previous source keeps the new bytes and the new source is shorter
- `unchanged`: the same content is already snapshotted; no writes happen

Detection compares content hashes, not byte offsets. A file is not append-only in general. Pi can rewrite, truncate, or migrate older sessions.

## Status and diagnostics

A manifest is `complete` when every line parsed as a JSON object. It is `partial` when malformed lines remain. A partial snapshot still preserves the raw source in full. The manifest records each malformed line and the parse error, up to the first 20 diagnostics. Later failures set a `diagnosticsTruncated` flag.

The header must be a `session` entry with an `id`. A file with no valid header fails with a structured error, exits nonzero, and writes nothing.

Ingestion never changes the source file. It only reads it.

## Failure safety

Snapshots are written to a temporary directory and renamed into place. An interrupted write leaves the previous snapshot readable. `latest.json` updates only after the new snapshot is complete. Store files use private permissions (`0o700` directories, `0o600` files).

## Limits

This path preserves source only. It does not normalize entries, pair tool calls, or classify commands. Those extractors run later and read from the preserved snapshots. It does not record byte ranges yet; line and byte provenance for normalized records is a later checkpoint.