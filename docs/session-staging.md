# Pi, Claude Code, and Codex session staging

Run `dvdst session-stage --agent pi`, `--agent claude`, or `--agent codex` from the target repository. This uses the existing replay and atomic index transaction. It never commits or changes working files.

```bash
dvdst session-stage --agent pi --list
dvdst session-stage --agent pi --dry-run
dvdst session-stage --agent codex --list
dvdst session-stage --agent codex --dry-run
dvdst session-stage --agent codex
dvdst session-stage --agent claude --session-file /absolute/transcript.jsonl --dry-run
```

In a source checkout, use `npm run --silent dvdst -- session-stage ...`. If running from the dvdst directory, pass `--repository /absolute/target-repository`.

Pi discovery uses `PI_SESSION_FILE`, the exact current transcript that Pi exports to commands run by its bash tool. Without it, `PI_SESSION_ID` (or `--session`) is matched against `<timestamp>_<id>.jsonl` names beneath `PI_CODING_AGENT_SESSION_DIR`, else `PI_CODING_AGENT_DIR/sessions` (default `~/.pi/agent/sessions`). An explicit `--session` searches by identity instead of using `PI_SESSION_FILE`; when both `PI_SESSION_FILE` and `PI_SESSION_ID` are set they must agree. A session directory chosen with Pi's `--session-dir` flag or settings file is only visible through `PI_SESSION_FILE` or `--session-file`.

Claude and Codex discovery uses `CLAUDE_CODE_SESSION_ID` beneath `CLAUDE_CONFIG_DIR/projects` (default `~/.claude/projects`) or `CODEX_THREAD_ID` beneath `CODEX_HOME/sessions` (default `~/.codex/sessions`). `--session` supplies an explicit identity. `--session-file` supplies the verified file and derives identity from its header when `--session` is omitted. Missing or ambiguous discovery fails; the command never guesses the latest session. A supplied identity must match the evidence, and the transcript must be the selected agent's format. Environment names are conveniences, not prerequisites.

`--list` prints successful mutation selectors, paths, and operations as JSONL without acquiring the index lock. On stderr it states how many successful bash commands look file-mutating: bash edits are never attributed, listed, or staged for any agent. `--dry-run` runs normal staging checks under Git's index lock without publishing. Exit 0 means staged or empty, 1 means a conflict with the index unchanged, and 2 means an input/execution failure. `--manifest` takes the existing HEAD-pinned cross-session format and needs a caller identity.

## Evidence support

Pi session files already record the canonical shape: `edit` has `path` and `edits: [{oldText, newText}]`, and `write` has `path` and `content`. Staging pairs each `toolCall` with its `toolResult` and keeps calls whose result has `isError: false`; failed calls and calls with no recorded result are not staged. The result ID is the `id` of the `toolResult` entry. Pi records the model's raw arguments and normalizes them only when the tool runs, so staging applies the same deterministic normalization: `edits` sent as a JSON string, a single edit object instead of an array, and the legacy top-level `oldText`/`newText` pair (appended after any `edits`). Replay is exact. Pi's edit tool tries an exact match first and falls back to whitespace/Unicode-normalized fuzzy matching; an edit that only matched fuzzily, or a CRLF file edited through Pi's line-ending normalization, has no exact anchor and fails closed as a conflict. Whole-file `write` to a path tracked in HEAD is refused, as for the other agents. Forked Pi session files (`parentSession` in the header) are refused because they copy the parent's entries and would stage inherited mutations. Bash edits are not attributed; they appear only as `unattributedBash` warnings. The bundled Pi live recorder remains an alternative source through `dvdst stage --input`.

Claude transcripts retain the existing successful Edit/Write conversion. Intentional `replace_all` edits replay all nonoverlapping occurrences; ordinary edits still require unique anchors. Bash changes and subagent sidechains are not attributed by this default route. Whole-file Write to a tracked path remains refused.

Codex staging reads `session_meta`, `turn_context`, and matched `response_item` calls/results. It supports native `apply_patch` calls and this exact exec wrapper with one JSON string literal:

```js
text(await tools.apply_patch("*** Begin Patch\n*** Add File: file.txt\n+hello\n*** End Patch"));
```

Recorded JavaScript is never executed. Native tools require a successful patch result. Supported exec cells are sequential literal tool calls: patch calls may share a cell with literal exec_command/write_stdin calls and fixed read-only tool-catalog/image inspection forms. They require successful script completion and one output slot per statement; each patch needs its own successful result (`{}` in this runtime). Shell calls stay unattributed. Catches, computed arguments, rebinding, interpolation, incomplete or truncated patch output, and arbitrary wrappers are not reconstructed. `--list` warns when unsupported cells contain patch syntax. Failed or unfinished calls are excluded; duplicate calls/results are refused.

Same-session paginated rollouts are not forks. File loading finds sibling segments for the verified session ID, orders their starting ordinals, and verifies the recorded predecessor byte offset and exclusive ordinal boundary. Predecessor tails beyond that boundary are superseded; the continuation owns later records. Missing roots, gaps, duplicates, broken boundaries, and cross-session inheritance fail. Root or continuation paths load the same complete chain. String-only collection cannot resolve files and refuses continuation headers.

Add File stages its complete recorded payload only when the path is absent from HEAD. Update File starts with a unique, exact, newline-terminated locator and replays subsequent hunks in their recorded order, choosing the first exact line match after the preceding consumed hunk as the Codex patch format specifies. Context-only hunks retain their locator role. No fuzzy matching is used; repeated first locators and missing later anchors fail. Context-free insertion, deletion, move, binary content, or unrepresented newline changes are unsupported and fail closed. No contents are reconstructed from current working files. Each call retains its recorded cwd, including later turn-directory changes.

Codex result IDs are `codex:result:<call_id>`. A cell with multiple patches uses `codex:result:<call_id>:patch:<zero-based-index>` for each patch, paired with that patch's recorded output slot. Every file in one multi-file patch shares its result ID: list output contains one row per path, but a manifest selects that ID once. The default includes the complete patch. Optional `paths` selects whole recorded files by absolute path; `selection.omitted` audits the sibling files not included. Every replacement for a selected file remains included, and there is no per-hunk selector. Inspect scope and sibling dependencies before narrowing a patch.

## Continue after committing

The default selection includes every successful mutation in the session. After committing, those earlier calls may no longer replay from HEAD. Use a fresh manifest or an explicit cursor:

```bash
dvdst session-stage --agent codex --after 'codex:result:<last-committed-call-id>' --dry-run
dvdst session-stage --agent claude --after '<result-entry-uuid>:<result-index>'
dvdst session-stage --agent pi --after '<toolResult-entry-id>'
```

`--after` excludes mutations through that successful result, including all files of a multi-file call. Unknown cursors fail. It cannot be combined with `--manifest`. Confirm every excluded dependency against actual commit scope; a cursor does not prove that earlier work was committed. Bash warnings still cover the entire source. No persistent receipt or automatic post-commit recovery is provided.

## Shared worktree boundary

Foreign unstaged hunks remain unstaged. Foreign staged changes block the entire operation and must not be cleared or absorbed. The existing index lock protects staging publication; it does not coordinate the subsequent review and commit across agents. Serialize closeouts, inspect the complete index, recheck HEAD and its tree immediately before committing, and validate the proposed snapshot when it differs from the tested worktree. Interdependent changes across agents require explicit manifest selection or ordered checkpoints.

Staging source support is separate from dvdst's analysis commands: staging joins verified Codex pagination segments, while analysis reads one supplied rollout segment.
