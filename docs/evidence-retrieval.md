# Exact call retrieval

Use `calls` to select compact evidence, then `call` to inspect an individual
call. Both work with Pi, Claude Code, and Codex, including unsupported tools
retained as generic evidence. No evidence store or model credentials are needed.

For prompts, replies, and surrounding conversation use
[messages, search, and message](conversation-exploration.md). `message --ref`
also accepts call refs to show the requesting assistant message and neighbors.

```bash
dvdst calls /path/to/session.jsonl --class test --limit 10 \
  --fields session,seq,callId,line,isError,ref
dvdst call /path/to/session.jsonl --id call-id --limit 2000
dvdst call /path/to/session.jsonl --seq 42
dvdst call --ref '<ref copied from calls>' --limit 2000
dvdst schema call --format json
```

## Row selection

Built-in row streams accept `--fields <comma-separated names>`, `--limit <n>`,
and `--offset <n>`. Field names come from `schema`. Limits are positive whole
numbers; offsets are nonnegative. Projection and pagination currently do not
apply to project extractors. Existing queries remain unlimited by default.

`calls` also accepts exact `--id <callId>`, `--seq <n>`, and `--class <name>`
filters, alongside `--tool` and `--errors`. Filters combine with AND. Sequence
and call-ID filters apply within each selected segment, so they can return
more than one row across multiple files. Use an exact file or `ref` to select
one particular call.

Pagination runs after filtering and before projection, across all selected
files in their resolved order. `--last` still limits sessions, not rows.
Offsets are not snapshot cursors: refresh discovery when the selected files
change. Files beyond the returned page are still checked; unreadable files
still cause nonzero exit with diagnostics, even if some rows were returned.

Projection works with JSONL, JSON, and TSV. Selecting `args`, `resultText`, or
`text` requires `--full`; absent projected fields are null. Full retrieval
still parses the complete supplied segment. These controls bound returned
rows, not parser memory or runtime. Use `call` to bound text payloads without
returning every call's arguments and results.

## References and snapshot changes

Each file-loaded call row carries `ref`, an opaque local reference pinning the
absolute file path, SHA-256 of the exact bytes parsed, call ID, and source
line. It distinguishes files sharing the same session ID. Keep `session` and
source `line` for citations; retain `ref` for follow-up retrieval. References
contain local paths and are not portable identifiers or access credentials.

Any raw byte change, including an append or whitespace change, makes an old
reference stale. `call --ref` refuses it. Refresh `calls` for the same file
and use the new reference. This intentionally does not reconstruct ancestry
or join paginated Codex segments. No snapshots are persisted automatically.
Library `deriveRows` without a fingerprint emits `ref: null`.

`call <session>` accepts exactly one of `--id` or `--seq`. Missing calls and
ambiguous call IDs fail; ambiguous IDs can be disambiguated with sequence.
`call --ref` cannot be combined with a session or ID/sequence selector.

## Payload slices

`call` writes one JSON object with `schemaVersion: 1`, `source`, `path`,
`fingerprint`, compact `call` metadata, and independently sliced `command`,
`args`, and `result`. The command and argument/result bodies are excluded
from the nested metadata row. `args` is serialized JSON text, so an excerpt
is not necessarily valid standalone JSON. Missing command/result is null;
an unfinished call does not acquire a fictional empty result.

Each text slice contains:

- `text`: the selected excerpt.
- `offset`: its zero-based Unicode code-point offset.
- `totalChars`: the complete text length in Unicode code points.
- `nextOffset`: the next position to read, or null at the end.
- `truncated`: true if any prefix or suffix was omitted.

The default `--limit` is 4096 characters per text field; valid limits are
1–65536. Set `--args-offset`, `--result-offset`, or `--command-offset` to
continue that field. An offset beyond the text length fails. The limit
bounds each text field; it is not a total JSON byte budget or a bound on
metadata arrays. JSON escaping and Unicode affect the final byte count.

```bash
dvdst call --ref '<same ref>' --limit 2000 --result-offset 2000
```

Programmatic callers can import `readCall`, `ReadCallOptions`, `TextSlice`,
and `CALL_SCHEMA` from `dvdst`. CLI and library share validation and retrieval.

## File, command, and skill references

`files`, `commands`, and `skills --contract exploration` expose the same call
and message references; pass the contract flag to each command. These queries
add bounded rows, filters/projection, and source completeness to inspection.
Stored mode reads a pinned raw snapshot, so its refs lead to the store file.
See [inspection queries](inspection-queries.md) for schemas, compatibility,
explicit/inferred targets, completion states, and attribution boundaries.

## Trace and summary evidence

`trace` continues to return provenance and skill/file/command associations.
It now recognizes every tool call and canonical record ID, returning
`callEntries` and `records` source locations. JSON includes `found`, `path`,
and `session`. A missing record exits 1 in JSON, TSV, and text; it never
reports success just because the selected output format is JSON. Use `call`
for bounded call contents.

Probe schema `0.2.0-probe` and handoff schema `0.2.0-handoff` add `validation`:
attempted/completed/passed/failed/unfinished test counts, unfinished call count,
latest command attempts, unresolved latest failures, the last potential
mutation, opaque effects, and passing tests dispatched after that mutation
settled. Evidence entries include call IDs, lines, result lines, and references.
Latest command entries include a bounded command preview and an arguments
hash; identical command text with different recorded arguments is a separate
attempt series. A successful retry must be dispatched after the failure result;
overlapping executions do not clear it. Historical failure totals remain intact.

`tests.ran` now means a test has a recorded completion. An unfinished call
produces `outcome: unfinished`. A pass before the final potential mutation,
or dispatched alongside it, produces `validation-stale`. Opaque effects
prevent a `stable` outcome. `stable` means limited recorded validation evidence,
not correctness or user acceptance; devlog generation preserves that outcome
instead of translating it to `accepted`. Explicit devlog status is reported
separately. Missing coverage and unrecorded effects remain limitations.
