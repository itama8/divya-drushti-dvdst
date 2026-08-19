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

## Normalized records

`dvdst normalize` reads a stored snapshot and writes derived records beside the raw source:

```bash
npm run --silent dvdst -- normalize \
  ~/.pi/agent/sessions/--home-a2ajinkya-Projects-omakase-v2--/<session>.jsonl \
  --store .dvdst/store
```

With a session file, the command ingests it first (a repeat reports `unchanged` and writes nothing), then normalizes the latest snapshot. To normalize an already stored session:

```bash
npm run --silent dvdst -- normalize \
  --store .dvdst/store --session <session-id>
```

The snapshot gains a `records/` directory and `derived.json`:

```text
snapshots/<sha256>/
├── manifest.json
├── derived.json
├── source/
│   ├── raw.jsonl
│   └── source-state.json
└── records/
    ├── entries.jsonl
    ├── messages.jsonl
    ├── tool-invocations.jsonl
    ├── tool-results.jsonl
    └── timeline.jsonl
```

- `entries.jsonl`: one record per source entry with its type, parent link, timestamp, provenance, and the original value
- `messages.jsonl`: conversation view with role, readable text, and tool-call or thinking flags
- `tool-invocations.jsonl`: tool calls with their arguments
- `tool-results.jsonl`: tool results keyed by tool call ID
- `timeline.jsonl`: append-order index that joins the other streams

Every record carries the source line and byte range. `derived.json` records extractor version, counts, and diagnostics. It lists orphan tool calls and orphan results when a result is missing or a result has no matching call.

Payloads at or above 64 KiB move to the shared content-addressed store:

```text
store/
└── blobs/
    └── sha256/<two-hex-prefix>/<sha256>
```

The blob holds the exact payload bytes. The referencing record keeps `{blob, bytes}` instead of the text, so a consumer can read conversation text without loading large tool output. Equal payloads share one blob, locally: no network calls happen during normalization.

The extractor is deterministic and idempotent. Re-running it rewrites identical records and never touches `source/raw.jsonl`. The named record streams are the CP2 deliverable; file, search, command, and test artifacts build on them in a later checkpoint.

## Tool artifacts

`dvdst artifacts` turns the normalized tool records into tool-specific evidence:

```bash
npm run --silent dvdst -- artifacts \
  ~/.pi/agent/sessions/--home-a2ajinkya-Projects-omakase-v2--/<session>.jsonl \
  --store .dvdst/store
```

With a session file, the command ingests it first, then normalizes if needed, then extracts artifacts. It also accepts an already stored session:

```bash
npm run --silent dvdst -- artifacts --store .dvdst/store --session <session-id>
```

The snapshot gains an `artifacts/` directory and `derived-artifacts.json`:

```text
snapshots/<sha256>/
├── manifest.json
├── derived.json          normalization extractor output
├── derived-artifacts.json  artifact extractor output
├── source/…
├── records/…
└── artifacts/
    ├── file-reads.jsonl      read calls with requested range and returned bytes
    ├── file-mutations.jsonl  edit and write calls with their patches
    ├── searches.jsonl        web and search-style tools
    ├── commands.jsonl        bash calls with output and classification
    ├── tests.jsonl           commands classified as tests
    └── unknown-tools.jsonl   every other tool, never dropped
```

Mutation records state whether the patch is observed from the arguments or reconstructed, and never claim an exact final diff without repository before-and-after state. Commands are classified deterministically as test, typecheck, build, lint, or dependency; each classification records its rule reason and the classifier version, so the result is auditable and reproducible. Orphan calls and results stay visible in the derived diagnostics. Large command output and write bodies are already blob-referenced by the normalizer, so artifact records stay small.

Query the artifacts from the store without the source file:

```bash
npm run --silent dvdst -- files --store .dvdst/store --session <session-id> --format json
npm run --silent dvdst -- commands --store .dvdst/store --session <session-id> --class test
npm run --silent dvdst -- commands --store .dvdst/store --session <session-id> --class typecheck | jq -c 'select(.result.isError)'
```

## Limits

Ingestion itself preserves source only. Normalization is a separate, repeatable step that reads the preserved snapshot. It does not yet classify commands, extract file artifacts, or attribute skill spans; those extractors run later and read the same records and blobs. It also does not compute branch depth or selected-branch views; parent links and append order are preserved so a consumer can reconstruct ancestry without replaying the raw file.