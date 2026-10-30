# Review: DVDST as an exploration tool for models

Reviewed 2026-10-31 against the current checkout. This is a proposal, not an
implemented contract. No CLI behavior was changed for this review.

Implementation checkpoint: the first follow-up adds bounded call selection and
expansion, snapshot-pinned call references, generic call/record trace lookup,
and ordered handoff validation. See [retrieval contracts](evidence-retrieval.md).
The second follow-up adds message listing, literal message/command/result
search, bounded neighborhoods, and conversation-query page/completeness
metadata. See [conversation contracts](conversation-exploration.md). The third
follow-up adds a shared built-in command catalog and executable option contracts;
see [command discovery](command-discovery.md). Legacy output field schemas and
completeness metadata for older analysis commands remain further work below.

## Product boundary

DVDST's offering is access to useful, source-backed session evidence. A model
should be able to discover relevant sessions, search what happened, narrow the
results, inspect individual records, and follow references without reading a
transcript wholesale. Cookbooks, templates, and skills demonstrate useful
patterns; they should not be prerequisites for ordinary exploration.

The existing foundation is strong: local processing, common rows across Pi,
Claude Code, and Codex, call/result joins, explicit unknown outcomes in call
rows, source locations, command classification, caching, and extensible
extractors. Keep these. CLI and library access already let models compose
their own investigations without DVDST making model calls.

## Findings

### 1. High: summaries overstate what the evidence establishes

`src/handoff/summary.ts` counts test commands regardless of whether a result
exists. `classifyOutcome` considers aggregate failures and test counts, without
ordering validation relative to mutations or accounting for unfinished calls.
Temporary synthetic Pi transcripts reproduced:

- One `npm test` call, no result: `tests.ran: true`, `outcome: "stable"`.
- Failed `npm test`, then successful identical retry:
  `outcome: "unresolved-failure"`.
- Successful `npm test`, then successful edit: `outcome: "stable"`.

These are distinct evidence states that an exploring model needs to see.
Replace the coarse verdict with ordered observations: attempted, completed,
passed, failed, unfinished, latest matching attempt, and validation after the
last observed mutation. Preserve historical failures. A later successful exact
retry can be identified without claiming that every earlier failure is resolved.
Unknown file effects must qualify any validation-after-mutation conclusion.
Acceptance and correctness remain conclusions for the consuming model/user.

### 2. High: finding one record requires retrieving too much

`src/cli/analysis.ts` exposes `--tool` and `--errors`, but no row limit, cursor,
field projection, call ID/sequence selection, turn range, or command-class
filter. `--last` limits sessions, not rows. `--full` adds entire arguments and
results; even compact rows contain complete shell command text.

A local session with 278 calls returned 218,393 bytes for `calls` and 908,516
bytes for `calls --full`. `--errors` reduced that to 12 rows / 11,170 bytes.
This is an illustrative sample, not a corpus performance benchmark. No private
transcript contents or paths are included here.

The fixture confirms `--limit`, `--seq`, and `--class` are rejected by `calls`.
The documented `--full | jq 'select(...)'` workaround reduces bytes returned
to the model, but still loads every payload and requires a separate filter.

Add common field selection, filtering, row limits, and continuation. Add exact
record retrieval with independently bounded argument/result excerpts. Report
truncation and how to retrieve the next slice. Bound both row count and payload
size: one large command or result can exceed a model's tool-output limit.

### 3. High: conversation content is missing from the exploration interface

`turns` describes assistant messages through usage and tool metadata; even
`turns --full` does not expose their text. There is no built-in message stream
or search across user requests, assistant replies, and tool results.
`overview.firstPrompt` provides only the first 200 characters of the first
request. Probe goals provide previews of user messages, not a general
conversation query surface.

This blocks ordinary questions such as "where did we decide this?", "what
did the user correct?", and "what was said around this failure?" unless the
model reads raw records or writes an extractor.

Add role-aware messages and literal search with scoped targets and bounded
excerpts. Every hit should support expansion to the original message and its
neighbors, and navigation to associated calls. Start with deterministic search;
semantic search is not needed to establish this interaction.

### 4. High: references do not consistently support follow-up queries

`calls` carries `session`, `line`, `resultLine`, and `callId`. However,
`trace` uses `buildProbeBundle` and checks only skill associations, skill
invocations, file summaries, and shell commands. It is not a generic record
reader. With the Claude fixture's existing read call `t1`, JSON trace returns
only `{ "attributions": [] }`.

A missing ID returns the same object and exit 0 in JSON mode; text mode
reports not found and exits 1. Consumers cannot distinguish a missing record
from an existing record without matching associations.

Identity also needs a file/segment dimension. Local discovery returned two
Codex files sharing a session ID; analysis intentionally reads each supplied
segment without joining ancestry. Call sequences and line numbers are local
to their files, while non-overview rows omit source path and agent.

Return an opaque, reusable evidence reference identifying source, segment or
snapshot, and record location. Resolve it through a generic reader. Live-file
references need an explicit append/change policy; do not silently apply a
cursor to a changed prefix. Preserve raw line/byte provenance. Represent
segments honestly rather than joining or deduplicating them speculatively.

### 5. Medium: commands require learning several different interfaces

The dispatcher lists 26 built-ins. The analysis commands default to JSONL;
`files`, `commands`, and `skills` default to TSV; `handoff` and `trace` default
to text. Analysis accepts `--source`, `--project`, and multi-session selection,
while direct inspection does not. `schema commands --format json` is rejected.
Direct and stored command results also use different field shapes.

`files --help` exits 2. Some commands silently fall back to a format for an
invalid `--format` value. Unknown-option errors give generic Node argument
advice rather than DVDST-specific recovery instructions.

Create a machine-readable command catalog with argument schemas, defaults,
output schemas, source coverage, and side effects. Share selection and output
handling across exploration tools. Validate unsupported arguments and formats
consistently. Keep existing CLI forms compatible during migration.

### 6. Medium: discovery can select the wrong scope quietly

`src/pi/resolve-sessions.ts` defaults recent discovery to Pi, uses
`PI_SESSION_FILE` for no-argument current-session selection, and falls back to
other projects when there is no matching cwd. `latest` is newest start time,
not the calling agent. These behaviors are documented, but the query result
does not explain how selection happened.

Add explicit project/source scope and selection metadata. Prefer no matches
over an implicit project-wide fallback; make broadening deliberate. Keep the
old default source compatible initially, but provide an explicit cross-source
discovery entry point. Do not infer "current" from "latest".

### 7. Medium: completeness and evidence strength need machine-readable form

Analysis can emit successful rows and still exit nonzero for unreadable files;
details live on stderr. `events` writes findings to a store and returns a
descriptor rather than findings. `files` differs between direct explicit file
tools and stored inferred shell effects. Call `mutates` describes recorded
targets, including failed or unfinished attempts and inferred shell effects;
the array alone does not prove a successful modification.

Offer structured query metadata: selected/read/failed sources, warnings,
partial status, returned count, and continuation. Preserve pipe-friendly row
output, with an explicit metadata mode or side channel rather than injecting
unexpected objects into existing JSONL streams. Expose findings through a
query operation even if snapshots remain an internal implementation detail.
Carry evidence basis and outcome beside effects so models need fewer joins
and fewer remembered caveats.

## Proposed tool surface

Use a small set of composable operations with one shared contract. The names
below describe operations, not a commitment to new top-level CLI spellings.

- **Discover sessions:** filter source, exact project/cwd, time, and identity;
  return compact metadata, segment identity, coverage, and reusable references.
- **Query evidence:** messages, calls, files, findings, and usage, sharing
  selection, field projection, filters, limits, and continuation. Retain
  existing `overview`, `calls`, `turns`, and `context` as familiar entry points.
- **Search evidence:** literal query over selected message roles, commands,
  paths, or result text; return bounded excerpts and evidence references.
- **Read evidence:** expand a reference, fetch adjacent messages/calls, or read
  a bounded result slice. Generic retrieval must include unsupported tools.
- **Describe capabilities:** discover available operations, input/output
  schemas, source limitations, and whether an operation writes anything.

Expose these through shared typed library functions and the CLI first. An MCP
adapter can expose the same functions if direct tool registration is useful;
it should not maintain a separate implementation. A transport alone will not
fix missing search, oversized output, or ambiguous references.

Keep script composition and extractors for unusual analyses, custom joins, and
reusable project logic. Common selection and record retrieval should not
require authoring an extractor. Do not turn each cookbook recipe into a
special-purpose command or introduce a new general query language.

## Suggested implementation order and acceptance

1. **Trustworthy retrieval:** fix trace not-found semantics and generic record
   access; introduce segment-aware references; add bounded call selection and
   payload slicing. Gate: a model can expand one call without fetching all
   session payloads, including when two segments share a session ID.
2. **Conversation exploration:** add messages, literal search, and neighborhood
   expansion. Gate: find a late user correction or decision and inspect its
   surrounding exchange without raw JSONL or custom code.
3. **Consistent contracts:** catalog/schema coverage, shared selection/format
   validation, structured partial-result metadata, explicit discovery scope.
   Gate: compose discovery into every exploration operation without manually
   translating session conventions; handle an unreadable selected file clearly.
4. **Derived evidence:** correct outcome ordering and expose queryable findings
   with basis, uncertainty, and underlying references. Gate: distinguish the
   unfinished, retried, and edited-after-test synthetic cases above.

Fix the false `stable` result early even if the broader findings API comes
later. Preserve staging's independent HEAD pinning, exact replay, and index
protections throughout; exploration changes do not justify loosening them.

Test these as short exploration tasks across all three sources, not only as
parsing tests or assertions that cookbook output remains unchanged. Measure
tool calls, bytes returned, failed query attempts, reference resolution, and
whether conclusions stay within the recorded evidence. Establish a baseline
before setting numeric targets. Then run real model walkthroughs with only
the capability description and schemas; fixtures alone do not prove usability.

## Review validation

- Exercised schema, overview, calls, turns, files, commands, trace, help, and
  unsupported filters through `node bin/dvdst.mjs` using synthetic fixtures.
- Queried ten local project transcript segments across all three sources;
  measured output size on one larger session without copying private content.
- Reproduced the three handoff outcomes using temporary synthetic transcripts,
  then removed the temporary files.
- `npm run typecheck` passed; `npm test` passed, 181 tests in 42 suites.
- This is a code/CLI review and one agent's walkthrough, not a completed
  multi-model usability evaluation. No behavior fixes were made here.
