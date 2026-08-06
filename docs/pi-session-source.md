# Pi session source notes

## Purpose

This note records source facts that affect the first `dvdst` adapter. It separates verified Pi behavior from proposed `dvdst` behavior.

## Inspected sources

The planning pass inspected:

- Pi `docs/session-format.md`
- Pi `docs/sessions.md`
- Pi `docs/compaction.md`
- the current Pi session file
- the Omakase Pi session directory
- Omakase checkpoint and planning documents

The Omakase repository is at `/home/a2ajinkya/Projects/omakase-v2`. The handoff used `~/Project/omakase-v2`, which does not exist on this machine.

## Corpus facts

At the time of inspection, the Omakase Pi directory contained:

- 288 JSONL session files
- about 484 MiB of source data
- individual files larger than 12 MiB

The directory is:

```text
~/.pi/agent/sessions/--home-a2ajinkya-Projects-omakase-v2--/
```

This corpus is large enough to test discovery, incremental ingestion, large payload handling, and schema variation.

## Pi source structure

A Pi session file starts with a `session` header. Later lines contain typed entries.

Known entry types include:

- `message`
- `model_change`
- `thinking_level_change`
- `compaction`
- `branch_summary`
- `custom`
- `custom_message`
- `label`
- `session_info`

Entries form a tree through `id` and `parentId`. File order records append order. Parent links record conversational ancestry.

`dvdst` must preserve both orders. A single linear timeline cannot represent branch ancestry by itself.

## Message and content types

Message roles can include:

- `user`
- `assistant`
- `toolResult`
- `bashExecution`
- `custom`
- `branchSummary`
- `compactionSummary`

Assistant content can contain text, thinking, and tool calls. User and tool-result content can also contain images.

Tool calls carry an ID, tool name, and tool-specific arguments. Tool results refer to the call ID.

## Compaction and branches

Compaction does not delete old entries from the source file. It appends a summary checkpoint and retains links to relevant context.

New compaction records can embed `retainedTail`. Older records can use `firstKeptEntryId`.

A faithful adapter must not treat compaction summaries as replacements for original evidence. Summaries are source records with their own provenance and interpretation limits.

Branch summaries describe abandoned paths. They are useful source evidence, but they are not raw records of those paths.

## Version handling

Pi documents three session versions. Current files use version 3, but old files can use earlier versions.

Pi can migrate old sessions when it loads them. Therefore, a session file is not guaranteed to remain append-only forever.

Incremental ingestion must detect:

- appended bytes
- truncation
- source replacement
- version migration
- changes to previously ingested lines

A byte offset alone is not a safe change detector.

## Skill invocation evidence

Pi includes skill names and descriptions in the system prompt. A model normally invokes a skill by reading its `SKILL.md` file.

Pi also supports explicit `/skill:name` commands. Pi expands these commands into user messages with this shape:

```text
<skill name="..." location="...">
...
</skill>
```

The Omakase corpus currently contains hundreds of `SKILL.md` reads but few explicit expanded skill commands. This means most historical skill detection must start from file-read evidence.

A successful skill read proves that the instructions entered the conversation. It does not prove that every later action followed those instructions.

The session format does not record an end boundary for model-selected skill use. A turn-bounded attribution can label later messages and tool calls conservatively. Wider attribution must remain an explicit alternative view.

The loaded content in the session is the best evidence for the historical skill version. The current file on disk may have changed after the session.

## Evidence limits

The transcript does not always contain enough information to reconstruct a repository state.

Examples:

- `edit` arguments often contain old and new text, but only for the selected replacement.
- `write` contains the new file body but might not contain the previous body.
- `bash` can modify files through arbitrary commands.
- a tool result can be truncated.
- a referenced full-output file can later disappear.
- uncommitted changes can exist before the session starts.
- another process can modify the repository during a session.

The first model must distinguish:

1. transcript-observed operations
2. repository-observed state
3. inferred changes

It must not label an inferred patch as an exact session diff.

## Omakase needs that shape the first release

Omakase uses a checkpoint map, active plans, architecture contracts, devlogs, tests, and commit traceability.

The first deterministic analyses should support this workflow. Good initial questions include:

- Which files did the session read and modify?
- Which commands failed without a later successful retry?
- Which tests ran after the final observed mutation?
- Which modified files had no observed prior read?
- Which planning or architecture documents were touched?
- What evidence can support a session handoff?
- Which skills were loaded or explicitly invoked?
- Which messages and tool calls fall within each conservative skill span?
- Did a skill invocation change tool use, validation, failures, or output quality?

Semantic claims such as checkpoint completion should wait until the evidence layer proves reliable.

Historical comparisons can show associations between skill use and outcomes. Claims that a skill caused an improvement require controlled or matched runs.

## Privacy and safety

Sessions can contain source code, prompts, command output, images, environment values, credentials, and user data.

The first release must:

- remain local by default
- create private store directories
- avoid network calls during ingestion
- preserve raw evidence without silently redacting it
- provide explicit derived redaction or export later
- make destructive cleanup an explicit command
