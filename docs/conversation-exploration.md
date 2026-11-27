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
apply: Pi is the default source and `latest` is not the calling agent. When
`--last`, `--since`, `--source`, or `latest` finds no sessions for the working
directory, discovery selects from every project of that source and prints a
`dvdst: no ... sessions recorded for the working directory ...` notice on
stderr; stdout stays data. Pass `--project` or `--root` to choose explicitly.
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
Add `--full` to return complete text instead of a prefix; see
[full text](#full-text).

Assistant messages that hold only thinking or tool calls are still canonical
messages, so they appear as rows with `text.totalChars: 0` (a busy Claude
session can show dozens of `agent` rows per real reply). Add `--nonempty` to
skip messages with no visible text:

```bash
dvdst messages "$SESSION" --role assistant --nonempty --full --fields seq,ref,text
```

`--nonempty` is a filter like `--role`: `matched` counts the remaining rows,
`seq` still addresses the complete conversation (expect gaps), and
`message --seq` or `--ref` opens the same message. It applies to `messages`
only; `search` never matches empty text.

Each row has session/source/path, canonical ID and sequence, source line/byte
ranges, role, message `kind`, recorded `channel`, assistant turn and user-turn indices, bounded
`text`, and snapshot-pinned `ref`. `callIds`/`callRefs` link assistant messages
to tools. `resultCallId`/`resultCallRef` link results to uniquely identified
calls. Orphans retain text and IDs with null call refs. Unknown tools remain
generic evidence.

Only recorded text blocks are rendered, joined with newlines. Thinking/reasoning
block types, tool arguments, and image/binary payloads are not substituted for
conversation text. This is not raw transcript search. Conversion still excludes
Claude sidechains/meta entries and Codex event echoes, and covers only supplied
segments. Codex channels are retained where recorded. Newer rollouts record no
`channel` but a `phase` (`commentary` or `final_answer`) on assistant messages;
dvdst reports that phase verbatim as `channel`. Older rollouts may carry
`analysis`, `commentary`, or `final`. Pi and Claude Code record no channel, so
it is null. Analysis or commentary text is not evidence of a user-facing reply.

Claude can merge several entries into one canonical message. Its row's `line`,
`byteStart`, and `byteEnd` describe the first entry; `sources` includes other
entries supporting text and calls. These are raw JSONL entry ranges, not byte
offsets into decoded strings.

## Message kinds

User-role text mixes what a person typed with material the harness, client, or
a parent agent placed there. Every message row carries `kind`, and every search
hit carries the enclosing message's `messageKind` (`kind` there already names
the hit target):

| kind | Meaning |
| --- | --- |
| `human` | Entered through the agent's prompt path and carries no harness marker. |
| `injected` | Instructions or context the harness, client, or a parent agent added: AGENTS.md blocks, system reminders, Codex environment/permission/compaction-replay items, handoff and delegation prompts. System and developer messages are always `injected`. |
| `skill-expansion` | An expanded skill block, recognized with the same grammar the `skills` command counts as an explicit invocation. |
| `notification` | Command echoes, task or background-command notifications, interrupt markers. |
| `agent` / `tool` | Assistant messages and tool results. |
| `unknown` | User-role text with no structural signal and no marker. It is never guessed as `human`. |

Classification uses record structure first, per source:

- **Pi:** user `message` entries are prompts (extensions write separate custom
  entries). Skill expansions are distinguished by their block grammar.
- **Claude Code:** conversion already drops `isMeta`, compact-summary,
  command-wrapper, task-notification and interrupt entries; surviving prompts
  entered through the prompt path. Skill expansions loaded as meta entries are
  therefore absent, not classified.
- **Codex:** inputs echoed by an `event_msg` `user_message` or `item_completed`
  `UserMessage` are prompts; user items without an echo (AGENTS.md, compaction
  replays) are `injected`. A file with no echoes gives no structural signal.

Anchored text markers then refine a prompt into `notification`, `injected`, or
`skill-expansion`, or decide when structure is silent. `human` is not verified
authorship: a parent agent or script that submits through the same prompt path
(for example a Pi sub-agent launch) cannot be told apart. Codex's
`<skill><name>` block format is not parsed by the skills grammar and is
reported as `injected`.

`--kind` takes comma-separated kinds and combines with `--role`; `search`
filters by the enclosing message's kind. For example, to read only what was
typed: `dvdst messages "$SESSION" --role user --kind human --full`.

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
for an assistant message. Each has `kind`, `role`, `messageKind`, `channel`, matching `sources`
and first matching source `line`, a `match` offset/length, and bounded excerpt.
For merged Claude messages the hit line can be later than the message's first
line. Cross-block matches cite multiple entries; joining newlines are rendering
separators.

`messageRef` always opens the enclosing message. `refKind` identifies the
reader for `ref`: `call` for commands/joined results, `message` for conversation
text/orphan results. `message --ref` also accepts a call ref to anchor at its
requesting assistant message. A recorded statement does not prove a decision
was followed or a change accepted.

## Full text

`--text-limit` bounds each `text`/`excerpt` to 1–4096 code points (default
240). `--full` instead returns complete text, with no upper bound, in the same
`TextSlice` shape: `offset` 0, accurate `totalChars`, `nextOffset` null and
`truncated` false. For `search` the excerpt becomes the whole matched text,
and `match.offset` locates the hit inside it. `--full` and `--text-limit` are
mutually exclusive. Without `--full`, `truncated` and `totalChars` still report
what was cut, so a bounded pass can find which rows need a full one:

```bash
dvdst messages "$SESSION" --role assistant --full --fields seq,ref,text
```

Full text can be large; project only the fields you need and page with
`--limit`/`--offset`.

## Neighborhoods and continuation

`message` writes one JSON object, not rows:

```text
{schemaVersion, source, session, path, fingerprint, anchorSeq, messages, beforeRef, afterRef}
```

The anchor and its neighbors are `messages`-schema rows under `messages`; pick
the anchor with `seq === anchorSeq`. There is no top-level `message` or `text`
key. `dvdst schema message` and `message --help` state the same keys. By
default the window holds up to two messages before/after, and
`beforeRef`/`afterRef` name the nearest omitted neighbors. Windows
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

`messages`/`search` write one of three shapes:

| Flags | Stdout |
| --- | --- |
| default (`--format jsonl`) | one row object per line |
| `--format json` | one bare JSON array of rows, with no counts |
| `--page` | one JSON envelope object; rows are under `rows` |
| `--format tsv` | a header line, then schema-ordered columns |

The bare array is kept for existing callers. Use `--page` whenever counts,
continuation, or source completeness matter. Both accept `--fields`, `--limit`
(rows), `--offset` (rows), and `--text-limit` (1–4096 characters) or `--full`
(complete text), plus `--role` and `--kind` filters. Pagination
follows filtering across selected files. Bounded `text`/`excerpt` projection
needs no `--full`. Complete files are still parsed: no text index, parser-memory
bound, or use of the payload-free row cache is implied.

`--page` writes a JSON envelope with `schemaVersion`, `rows`, `matched`,
`offset`, `returned`, `nextOffset`, `complete`, `selectedSources`,
`readSources`, and `failedSources`. An `--offset` at or past `matched` gives
`returned: 0` and `nextOffset: null`. Without `--page`, stdout stays pure data
(nothing for JSONL, `[]`, or only the TSV header) and stderr says
`dvdst: --offset N is at or past the M matching row(s); no rows returned`. The
analysis streams (`overview`, `turns`, `calls`, `context`) print the same
notice. It implies
JSON and rejects other formats. `complete` means every selected source was
read, not every hit was returned. Counts/continuation cover successfully read
files only. Unreadable sources cause nonzero exit even after the page fills.
Inspect failures before advancing through partial results. Offsets are ordinary
pagination, not snapshot cursors; refresh discovery if selected files change.

## Library

`loadConversation`, `conversationFromSession`, `listMessages`,
`searchConversation`, and `readMessage` are exported from `dvdst` and used by
the CLI. Listing/search return typed `{rows, matched, nextOffset}` pages with
the same defaults; `listMessages` accepts `nonempty: true`. `conversationFromSession` reuses a fully loaded `SessionData`.
Loaded conversations include full text for local computation; only query/read
results apply output limits; pass `full: true` for complete text and `kinds`
to filter. `MESSAGE_KINDS` and `classifyMessage` expose the kind vocabulary and
classifier. Schemas are exported as `MESSAGES_SCHEMA`, `SEARCH_SCHEMA`, and
`MESSAGE_SCHEMA`.

## Related evidence

[`files`, `commands`, and `skills`](inspection-queries.md) with
`--contract exploration` share query pagination/projection and return call and
message references. Follow `messageRef` to the enclosing conversation, or use
`message --ref` on a call ref to see its requesting assistant and neighbors.
Stored inspection refs identify the raw snapshot, preserving segment identity.
