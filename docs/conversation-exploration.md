# Conversation exploration

`messages`, `search`, and `message` let a model find an earlier request,
correction, reply, or tool result and inspect the surrounding conversation.
They read Pi, Claude Code, and Codex transcripts directly without an ingest
step, model calls, or a project extractor.

```bash
dvdst overview --project my-project --source all --last 10
dvdst search /path/to/session.jsonl --query 'keep local Open' --role user --page
dvdst message --ref '<messageRef copied from the hit>' --before 2 --after 2
dvdst call --ref '<callRefs item copied from a message>' --limit 2000
```

Use the exact path from overview for a known session. Discovery for `messages`
and `search` accepts the analysis file/ID/prefix/`latest` selectors, `--source`,
`--project`, `--root`, `--last`, and `--since`. Existing scope caveats still
apply: Pi is the default source and `latest` is not the calling agent.
`schema messages`, `schema search`, and `schema message` describe every field;
`schema` also lists them alongside existing stream and call schemas.

## Message rows

```bash
dvdst messages /path/to/session.jsonl --role user,assistant --limit 10
dvdst message /path/to/session.jsonl --seq 42 --before 1 --after 1 --limit 1000
```

`messages` defaults to user/assistant roles, 20 rows, and 240 characters per
message. `--role` accepts comma-separated `user`, `assistant`, `toolResult`,
`system`, or `developer`, or `all`. Filtering never renumbers messages: `seq`
addresses the complete canonical conversation, including tool-only messages.

Each row has session/source/path, canonical ID and sequence, source line/byte
ranges, role, recorded `channel`, assistant turn and user-turn indices, bounded
`text`, and snapshot-pinned `ref`. `callIds`/`callRefs` link assistant messages
to tools. `resultCallId`/`resultCallRef` link results to uniquely identified
calls. Orphans retain text and IDs with null call refs. Unknown tools remain
generic evidence.

Only recorded text blocks are rendered, joined with newlines. Thinking/reasoning
block types, tool arguments, and image/binary payloads are not substituted for
conversation text. This is not raw transcript search. Conversion still excludes
Claude sidechains/meta entries and Codex event echoes, and covers only supplied
segments. Codex `analysis`, `commentary`, or `final` channels are retained where
recorded; analysis text is not evidence of a user-facing reply.

Claude can merge several entries into one canonical message. Its row's `line`,
`byteStart`, and `byteEnd` describe the first entry; `sources` includes other
entries supporting text and calls. These are raw JSONL entry ranges, not byte
offsets into decoded strings.

## Literal search

```bash
dvdst search --project my-project --source all --last 10 --query 'parser failed' --in results --limit 5
dvdst search /path/to/session.jsonl --query 'npm test' --in commands
dvdst search /path/to/session.jsonl --query 'LOCAL OPEN' --ignore-case
```

`--query` must be nonempty. Matching is case-sensitive by default; `--ignore-case`
uses Unicode simple case folding. Queries are literal: metacharacters such as
`.*` and brackets never become user regex syntax.

`--in` selects `messages` (default), `commands`, `results`, or `all`.
Message hits default to user/assistant text. Commands search normalized shell
command text with role `assistant`; results search tool-result text with role
`toolResult`. In `all`, results appear once as result hits. Explicit `--role`
filters every target: `--role user --in all` returns no command/result hits.
Use `--role all` to include system/developer message text.

There is one hit per matching canonical message, command, or result, at its
first match. Hits follow canonical message order, with text before commands
for an assistant message. Each has `kind`, `role`, `channel`, matching `sources`
and first matching source `line`, a `match` offset/length, and bounded excerpt.
For merged Claude messages the hit line can be later than the message's first
line. Cross-block matches cite multiple entries; joining newlines are rendering
separators.

`messageRef` always opens the enclosing message. `refKind` identifies the
reader for `ref`: `call` for commands/joined results, `message` for conversation
text/orphan results. `message --ref` also accepts a call ref to anchor at its
requesting assistant message. A recorded statement does not prove a decision
was followed or a change accepted.

## Neighborhoods and continuation

`message` writes JSON with `anchorSeq`, up to two messages before/after by
default, and `beforeRef`/`afterRef` for the nearest omitted neighbors. Windows
include all roles, preserving nearby tools. Set `--before`/`--after` from 0 to
10; use 0/0 to inspect just the anchor.

`--limit` on this reader bounds text per message (default 2000, maximum 65536).
Each text uses the call reader's `TextSlice`: `text`, `offset`, `totalChars`,
`nextOffset`, `truncated`. Continue the anchor with `--text-offset`; neighbors
always start at zero. All text/match offsets are Unicode code points, not UTF-8
bytes or JavaScript indices. Text limits are not total JSON byte budgets and
do not bound metadata arrays. Tool-result text can include recorded envelopes
or source-side truncation; absent content is not reconstructed.

Refs pin exact raw segment bytes and distinguish files sharing a session ID.
Any append/change invalidates them; refresh `messages`/`search` for that file.
They do not join forks or missing history.

## Formats, pagination, and completeness

`messages`/`search` default to JSONL; `--format json` writes an array and
`--format tsv` writes schema-ordered columns. Both accept `--fields`, `--limit`
(rows), `--offset` (rows), and `--text-limit` (1–4096 characters). Pagination
follows filtering across selected files. Bounded `text`/`excerpt` projection
needs no `--full`. Complete files are still parsed: no text index, parser-memory
bound, or use of the payload-free row cache is implied.

`--page` writes a JSON envelope with `rows`, `matched`, `returned`, `nextOffset`,
`complete`, `selectedSources`, `readSources`, and `failedSources`. It implies
JSON and rejects other formats. `complete` means every selected source was
read, not every hit was returned. Counts/continuation cover successfully read
files only. Unreadable sources cause nonzero exit even after the page fills.
Inspect failures before advancing through partial results. Offsets are ordinary
pagination, not snapshot cursors; refresh discovery if selected files change.

## Library

`loadConversation`, `conversationFromSession`, `listMessages`,
`searchConversation`, and `readMessage` are exported from `dvdst` and used by
the CLI. Listing/search return typed `{rows, matched, nextOffset}` pages with
the same defaults. `conversationFromSession` reuses a fully loaded `SessionData`.
Loaded conversations include full text for local computation; only query/read
results apply output limits. Schemas are exported as `MESSAGES_SCHEMA`,
`SEARCH_SCHEMA`, and `MESSAGE_SCHEMA`.

## Related evidence

[`files`, `commands`, and `skills`](inspection-queries.md) with
`--contract exploration` share query pagination/projection and return call and
message references. Follow `messageRef` to the enclosing conversation, or use
`message --ref` on a call ref to see its requesting assistant and neighbors.
Stored inspection refs identify the raw snapshot, preserving segment identity.
