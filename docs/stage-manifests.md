# Stage an explicit cross-session selection

Use a manifest when accepted work depends on uncommitted edits from earlier sessions. The default single-session command stays unchanged.

A manifest pins the repository HEAD and selects successful tool calls in explicit replay order, including every file by default. It cannot supply replacement text. dvdst reads the recorded arguments and results from each source.

```json
{
  "schemaVersion": 1,
  "head": "<full HEAD object ID>",
  "sources": [
    { "kind": "session-file", "path": "/path/to/first.jsonl", "sessionId": "first" },
    { "kind": "session-file", "path": "/path/to/second.jsonl", "sessionId": "second" }
  ],
  "mutations": [
    { "sessionId": "first", "resultEventId": "result-of-create" },
    { "sessionId": "second", "resultEventId": "result-of-edit" },
    { "sessionId": "first", "resultEventId": "result-of-later-edit" }
  ]
}
```

`head` must contain a full 40- or 64-character lowercase Git object ID. The example placeholder is not valid input.

A selector may add `paths: ["/absolute/recorded/file"]` to select complete file mutations from a multi-file call. Each path must name a file in that successful call; all replacements for the selected file remain included. Empty, unknown, relative, and duplicate path lists fail. This permits staging each repository separately or excluding a superseded sibling file without manufacturing mutation evidence. Inspect the omitted files and required dependencies: the report lists them in `selection.omitted`.

## Build and inspect the selection

1. Record `git rev-parse HEAD` for the target repository.
2. Find each source session and verify its header ID and recorded working directory.
3. Inspect the successful mutation calls that belong to the accepted checkpoint.
4. List their result entry IDs in replay order, including required earlier creates and edits.
5. Exclude unrelated calls, even when they changed the same file.
6. Run a dry run, then resolve every reported conflict.

For Pi session files, `resultEventId` is the tool-result entry ID. For live streams, it is the finished event ID, or `source:sessionId:sequence` when the event has no ID.

Source paths resolve relative to the manifest file. Mutation paths resolve from each source's recorded absolute working directory. Absolute mutation paths retain their meaning. Session order is not sufficient when sessions overlap. The manifest can interleave their calls. dvdst does not infer ordering from timestamps.

```bash
npm run --silent dvdst -- stage --manifest selection.json \
  --cwd /path/to/repository --session <calling-session-id> --dry-run

npm run --silent dvdst -- stage --manifest selection.json \
  --cwd /path/to/repository --session <calling-session-id>

git diff --cached
```

`--session` identifies the caller in the report. The manifest separately verifies each evidence session ID. It does not automatically include the caller's mutations.

## Safety and reports

- Each selector must identify one successful mutation call. A Codex multi-file call selects all its files by default; explicit `paths` select complete recorded files. Unknown, failed, and duplicate selections fail.
- Duplicate source sessions and unused sources fail. Forked session files remain unsupported.
- HEAD must match under Git's index lock. A stale manifest fails without publishing an index.
- A selected path outside the target repository blocks the entire operation. It is not silently skipped.
- Exact replay, tracked-write restrictions, unrelated-index checks, cancellation, and atomic publication use the existing staging transaction.
- A repeated run accepts complete replay states in the index. It does not absorb foreign staged content.
- Reports use `source: "manifest"`. `selection` contains the manifest path, pinned HEAD, and ordered mutation identities with resolved paths. `selection.omitted` records intentionally omitted sibling file mutations when `paths` narrows a call.
- Bash warnings include all supplied sources, not only selected mutations. Their event IDs include the source session ID. No bash change is staged.

Inspect both `unattributedBash` and the complete staged diff before committing. Warnings are capped at 20 entries. `unattributedBashCount` reports the full count.

## Limits

The caller owns checkpoint membership and replay order. dvdst proves exact replay, not feature acceptance or semantic independence. A selected call includes all files by default; a selected file always includes all of its recorded edits. Individual replacements cannot be selected separately. Do not omit a sibling dependency merely to make replay or validation pass.

Recorded results do not prove that their changes still exist in the worktree. No automatic discovery, fuzzy matching, tracked-write pre-image capture, or persistent staging receipt is added.

After a commit, the old manifest is stale. Build a new selection against the new HEAD. Include only calls that still replay from that baseline. This is explicit selection, not automatic post-commit recovery.
For a single-session continuation, `--after <last-committed-result-event-id>` excludes earlier mutations; it cannot be combined with a manifest. Verify the cursor against actual commit scope. See [Claude and Codex staging](session-staging.md).

See [session staging](live-streams.md#stage-a-sessions-changes) for the shared transaction rules.
