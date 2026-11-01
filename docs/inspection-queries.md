# File, command, and skill exploration

`files`, `commands`, and `skills` expose a shared query contract for Pi, Claude
Code, and Codex. Discover them through `capabilities --group exploration` and
`capabilities files|commands|skills`; `schema files|commands|skills` returns the
same field schema as the capability descriptor. These operations require no
extractor, model call, credentials, or ingest step for direct transcripts.

## Compatibility and selection

Select the new contract explicitly with **`--contract exploration`**. Omitting
it (or passing `--contract legacy`) preserves the existing direct/store output
shapes, TSV default, and unlimited output. New query controls require the new
contract; they fail with a migration hint in legacy mode. Invalid formats and
inapplicable options fail instead of silently falling back. `--help` exits 0.

The declared schemas apply to the exploration contract, not legacy rows. A
capability descriptor's constraints and format default describe both modes.
Legacy direct files retain first/last source summaries and normalize paths;
stored file summaries retain artifact paths and only path/operations/count.
Legacy shell effects remain in the separate `bash-file-effects.jsonl` artifact,
not in stored `files`. Direct/stored commands retain different result shapes
(`textBytes` versus `outputBytes`) and missing-result representations. Legacy
direct skills omit unsuccessful loads; stored skills retain load statuses and
support attribution/spans. Those older meanings have not been rewritten.

```bash
dvdst files /path/to/session.jsonl --contract exploration --path src/ --page
dvdst commands --contract exploration --project my-project --source all --last 5 --class test --page
dvdst skills /path/to/session.jsonl --contract exploration --load-status unconfirmed --page
```

Transcript mode shares the analysis resolver: exact files, IDs/prefixes,
directories, `latest`, `--source pi|claude|codex|all`, `--project`, `--root`,
`--since`, and `--last`. Source defaults remain `DVDST_SOURCE`, then Pi.
`--last` bounds sessions, not rows. `latest` is not the current agent's identity;
verify the selected transcript with `overview`. Discovery's existing project
fallback and supplied-segment limits still apply. Prefer exact files for a known
session. Multiple selected segments remain independent even when IDs match.

Stored selection is a separate mode:

```bash
dvdst files --contract exploration --store /path/to/store --session exact-id --snapshot sha256 --page
```

It requires `--store` (alias `-s`) and `--session`, optionally `--snapshot`.
Positionals and transcript discovery flags cannot be combined with stored
selection. Session IDs shared across agents are refused unless a snapshot
uniquely selects one. Without a hash, the stored latest pointer is resolved once.
Exploration parses that snapshot's raw bytes and verifies its hash; it does not
query derived artifacts, create missing records, or write the store. References
lead to that raw file, so they survive changes to the original transcript but
require the local store file to remain available and unchanged. Legacy store
skills may still generate missing normalized records and skill extraction.

## Shared output and navigation

Exploration defaults to JSONL and 20 rows. `--format json` emits an array;
`--format tsv` emits schema-ordered columns. `--fields a,b` projects declared
fields in the requested order. Invalid/duplicate fields fail. `--limit` is a
positive integer; `--offset` is nonnegative. Filters combine with AND and run
before pagination, across all selected segments in resolver order.

`--page` implies JSON and rejects an explicit non-JSON format. It returns:

- `schemaVersion: 1`, `rows`, `matched`, `returned`, and `nextOffset` (null at end).
- `complete`, `selectedSources`, `readSources`, and `failedSources` containing
  `{path,error}` diagnostics. Every selected source is read, even after the page
  fills. A failed source causes exit 1; counts/continuation cover readable sources.
- `selectionMode`: `transcript` or `store`; `snapshot`: selected stored hash or null.

`complete` means all selected sources were read. It does not mean all rows were
returned, the transcript contains full history, every call completed, or the
work was correct. Inspect failures before advancing through partial results.
Offsets are ordinary pagination, not snapshot cursors; refresh if selection or
files change. The same pagination/projection emitter serves conversation queries.

Rows retain `session`, `source`, absolute `segment`, raw-byte `fingerprint`, and
`line`/`byteStart`/`byteEnd` entry ranges. Paths are local references, not portable
IDs. Call evidence has `callId`, `refKind: call`, and `ref` for `call --ref`.
`messageRef` opens the requesting message and neighbors. Explicit skill messages
and message attributions use `refKind: message`. For merged Claude messages, the
call's line/bytes can be later than the enclosing message; skill message evidence
also carries all supporting `sources`. `resultSource` identifies the recorded
result entry, or is null when absent/not a call. Entry byte ranges are not
substring offsets. Any raw byte change invalidates references.

```bash
dvdst call --ref '<ref from a command/file row>' --limit 1000
dvdst message --ref '<messageRef>' --before 1 --after 1 --limit 1000
```

## File targets

One row represents one explicit file-tool target or inferred shell effect,
including failed and unfinished attempts. It is deliberately not an aggregate
file summary. `path` normalizes in-project absolute paths against the recorded
cwd; `sourcePath` retains the target from normalized arguments or the shell
parser. It may differ from raw provider argument syntax. Filter with:

- `--path`: literal substring of normalized path.
- `--operation read|write|edit|mutation`: `mutation` is an unspecified shell mutation;
  Codex patch targets use `edit` with `via: apply_patch`.
- `--basis explicit-file-tool|inferred-shell`.
- `--outcome succeeded|failed|unfinished`.

`basis` describes how the target was identified. Even explicit arguments prove
only an attempt; a successful enclosing shell call does not prove each inferred
effect occurred. Unknown tools and opaque scripts acquire no invented effects.
Use `calls`/`call` for generic evidence that has no supported target extraction.

## Command attempts

One row represents one normalized shell call. `--class` filters existing project
classification; `--outcome` filters recorded completion. Nonzero exit codes or
error flags mean failed; a missing result means unfinished. Success means a
recorded completion, not adequate validation or acceptance. Native Codex running
shell calls stay unfinished until a recorded poll completes them.

`command` is a TextSlice (`text`, `offset`, `totalChars`, `nextOffset`, `truncated`),
default 240 Unicode code points. `--text-limit` accepts 1–4096. `commandBytes`
and `commandHash` describe the full normalized command; `opaque` lists unknown
effect reasons. Expand with `call --ref`, continuing its `--command-offset`.
Result bodies and argument payloads are never embedded in these query rows.

## Skill evidence

`--view invocations` (default) and `--view spans` return the invocation metadata
and active bounds. Both work directly or from stored raw snapshots. Filter with
`--name` (literal substring) and `--load-status expanded|loaded|failed|unconfirmed`.
`--view attributions` returns one row per invocation/record membership, including
its `recordKind`, `recordId`, and `attributionBasis`; filters select invocations
before expanding memberships. This keeps overlapping skills independently
queryable without unbounded nested labels.

Explicit expanded user skill blocks have observed confidence. A successful
SKILL.md read is an observed load but a reconstructed invocation candidate.
Failed/unconfirmed reads remain visible, with no active span, and only their
load-trigger association. Same-turn spans/attributions are associations, not
proof of adherence. No installed skill file is consulted to reconstruct content.
The pure skill derivation is shared with stored extraction; exploration uses the
canonical call/result joins, including supported Codex polling completion.

## Limits and library

Queries parse complete supplied segments. Row/text limits bound returned rows
and command prefixes, not parser memory, total JSON bytes, paths, or metadata
array sizes. Project classification rules can affect commands; this is not a
frozen classification snapshot. Claude sidechains/meta entries remain excluded;
Codex ancestry and missing segments are not reconstructed. Findings queries and
independent model usability evaluations remain separate work.

Library callers can import `queryInspection(session, kind, options)` and the
`FILES_SCHEMA`, `COMMANDS_SCHEMA`, and `SKILLS_SCHEMA` constants. Supply a fully
loaded `SessionData` (`loadSessionFile(path, {full:true})`); the query returns
`{rows,matched,nextOffset}`. The CLI adds selection, projection, formatting,
source-failure metadata, and store hash checks. No library query writes files.
