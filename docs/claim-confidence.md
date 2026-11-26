# Tool-call claim confidence

dvdst makes one central claim about a tool call: **this call changed this
file**. The claim can come from the call's own semantics (`edit`, `write`,
`apply_patch`) or from its command text (`sed -i`, a redirect, `rm`). This
document defines a deterministic confidence band for that claim, and a
first-class row for the calls where dvdst cannot name a file at all.

The bands are evidence tiers, not probabilities. They are computed from the
recorded call, its result, and the session cwd. No model, no network, no
filesystem replay is needed. Replay stays a separate, exact check.

The reference implementation is
[`examples/extractors/claim-confidence.mjs`](../examples/extractors/claim-confidence.mjs).
It is an extractor, so it can be run without changing the core:

```bash
node bin/dvdst.mjs rows examples/extractors/claim-confidence.mjs --project omakase-v2 --source all --last 50
node bin/dvdst.mjs rows examples/extractors/claim-confidence.mjs /path/to/session.jsonl
```

Copy it to `.dvdst/extractors/claim-confidence.mjs` to run it as
`dvdst claim-confidence` from a project directory.

The measurements below come from 500 `omakase-v2` sessions: 56 Claude Code,
122 Codex, and 322 Pi, 51,734 tool calls. Pi is included as a baseline because
its rows already carry the core tool names.

## 1. What actually edits files

Direct edit tools are a minority. Shell commands and inline interpreters do
most of the writing.

### Claude Code (56 sessions)

| tool | calls | dvdst claim | evidence |
| --- | ---: | --- | --- |
| `Bash` | 3,787 | inferred path | command text, exit status |
| `Write` | 94 | declared path | full body; result echoes the path |
| `Edit` | 80 | declared path | exact old/new text; result echoes the path |
| `MultiEdit` | 0 | declared path | per-edit `replace_all` is lost in canonicalization |
| `NotebookEdit` | 0 | not modelled | notebook cell edits are invisible |
| sidechain (subagent) | 0 | excluded | would be invisible if present |

Only 174 of 3,961 calls use a direct edit tool (4.4%). Shell is the editor.

- 431 shell path claims. Across all 612 Claude claims, 292 are inside the
  session cwd and 320 are outside it.
- 1,044 shell calls are opaque. 852 are inline `python`/`node` interpreters;
  668 of those carry a path hint from a write API (`open(..., "w")`,
  `write_text`, `writeFileSync`, ...), and 623 point inside the cwd. The
  transcript names the files inside the script, but dvdst makes no path claim.
- Path echo is reliable: all 173 successful `Edit`/`Write` results name the
  exact argument path. One write failed.

### Codex (122 sessions)

| tool | calls | dvdst claim | evidence |
| --- | ---: | --- | --- |
| `exec` | 8,212 | none | script text only; 2,439 are not expanded |
| `apply_patch` | 905 (1,429 paths) | declared path | patch envelope + wrapper success |
| nested `exec_command` | 6,376 bash rows | inferred path | command text, exit status |
| nested `write_stdin` | 2,169 | none | 2,168 poll with empty `chars` |

- 5,773 of 8,212 `exec` cells (70%) are expanded into nested calls. 2,439 are
  not, because the script uses bindings, loops, or a computed patch.
- Of the 2,439 unexpanded cells, 994 carry a write signal: `apply_patch` in a
  non-literal form, a shell redirect or in-place edit, an inline interpreter
  with a write API, or non-empty stdin input.
- Successful `apply_patch` returns `{}` through the exec wrapper. There is no
  path echo and no file list, so declaration plus wrapper success is the whole
  evidence.
- `apply_patch` covers `Add`, `Update`, `Delete`, and `Move`. Only `Update`
  with context and `Add` are stageable today; `Delete` and `Move` are claimed
  by analysis but refused by staging.

### Pi baseline (322 sessions)

`edit` 5,971, `write` 1,176, `bash` 17,712. The core tool names already carry
declared evidence, but 1,654 shell calls remain opaque.

## 2. Claim families today

1. `calls.mutates[]`: "this call changed these paths".
2. `files --contract exploration`: a target with `basis` and `outcome`.
3. `stage`: `staged`, `conflict`, `unchanged`, `unattributedBash`.
4. `artifacts`/`events`: `file-mutation` with `succeeded` and `patch.exact`.

Staging (3) and the artifacts stream (4) record outcome. `calls.mutates` (1)
does not: it sets a path from the tool name and arguments regardless of
`isError`. In this corpus, **385 failed calls still carry a mutation path**
(342 Pi, 43 Claude/Codex). The correct response depends on the tool. A failed
`edit` is atomic and wrote nothing. A failed shell command may have written
before the failing step: 50 of the 51 failed shell path claims in Claude and
Codex have no write error naming the path, and one sampled Codex call wrote
four files before an `rg` glob failed. One rule cannot cover both.

Warnings are the other gap. `unattributedBash` reports that a successful bash
call may have changed files, but:

- the list is capped at 20 and the remainder is only a count (one Claude
  session: 35 total; one Codex session: 133 total);
- signals are matched against the whole command, including heredoc bodies and
  quoted program text. On three sampled sessions, 48 of 57 shown warnings
  changed their signal set after heredoc bodies were removed, and 2 vanished
  entirely (`awk -F'|' 'NR>28 ...'` matches "redirect");
- an unexpanded Codex `exec` becomes a bash warning in staging, but its
  `calls` row has `mutates: []` and `opaque: []`. The analysis stream gives no
  signal at all.

Path scope is also unstated. Half of Claude's mutation claims (320/612) name a
scratch file, another repository, or a worktree, not the session cwd. They are
accurate claims; they are not part of this repository's change set.

## 3. Ruleset

### Step 1: attribution class

| class | condition | path claim |
| --- | --- | --- |
| `declared` | the tool binds path and content: `edit`, `write`, `apply_patch`, notebook edit | yes |
| `inferred` | a shell operator names a static path: redirect, `sed -i`, `rm`, `mv`, `cp`, `tee`, `dd` | yes |
| `opaque` | a program may write but names no path: inline interpreter, `git apply`, `patch`, computed path, `xargs`, unparsed exec | no, emit unknown |
| `none` | read-only | no |

Path resolution happens once, against the session cwd. A relative path stays
relative to that cwd. `cd` steps inside a shell call follow the existing
parser.

### Step 2: outcome gate

| outcome | declared | inferred |
| --- | --- | --- |
| succeeded | start at 0.90 | start at 0.55 |
| unfinished (no result) | 0.30 | 0.30 |
| failed, write error names the path | 0.10 | 0.10 |
| failed, any other error | 0.10 | 0.35 |

A failed `edit`, `write`, or `apply_patch` is treated as unwritten: the edit is
atomic and `apply_patch` verifies before writing. A failed shell command is
not atomic; it may have written before the failing step, so it drops to
`partial`, not to zero. This distinction is load-bearing. The sampled failed
Codex call wrote four files and then failed an `rg` glob; its four claims were
correct.

### Step 3: independent confirmation

| check | effect |
| --- | --- |
| successful result names the target path (`The file ...`, `File created successfully at: ...`, `Updated the following files: M path`) | raise declared to **1.00 verified** |
| successful result names a different path | **0.10 contradicted** |
| result says no change, unchanged, or already up to date | **0.10 contradicted** |
| result contains a write error (`permission denied`, `read-only file system`, `no such file or directory`, `no space left`, `unexpected EOF`) and names the target | **0.10 contradicted** |

The confirmation is about the call's own report. It does not prove the file
still contains the change, and it does not prove the path is the only file
the call touched.

### Step 4: scope

Scope does not change the accuracy score. It changes ownership.

| scope | meaning |
| --- | --- |
| `inside` | path is under the session cwd and inside the replay root |
| `outside` | scratch, another repository, or a worktree; the claim can be true and still not belong to this change set |
| `mixed` | an unknown names candidates on both sides |

Record it on every claim. An agent that asks "what did this session change?"
must filter on `inside`, and must not silently drop `outside` claims from a
staging decision.

### Step 5: stageability (separate axis)

| value | condition |
| --- | --- |
| `exact` | `edit` with non-empty anchors; `apply_patch` `Update` with context in every hunk |
| `conditional` | `write`, or `apply_patch` `Add`: replayable only when the path is absent from HEAD |
| `unsupported` | empty anchor, `Patch` `Delete`/`Move`, shell or exec mutation, notebook edit, lost `replace_all` |

`exact` means the transcript contains enough text to replay. It does not mean
replay will succeed against the current HEAD. That remains `stage --dry-run`'s
job: anchors not found, unrelated staged changes, and tracked writes are
reported as conflicts there.

### Bands

| band | score | meaning |
| --- | ---: | --- |
| `verified` | 1.00 | declared, succeeded, result names the path |
| `declared` | 0.90 | declared, succeeded, no independent naming |
| `inferred` | 0.55 | shell operator names a static path, succeeded |
| `partial` | 0.35 | shell operator names a path, call failed without a write error on it |
| `weak` | 0.30 | no result, or the claim rests on data rather than a shell operator |
| `contradicted` | 0.10 | failed declared tool, other path, write error on this path, or explicit no-change |
| `unknown` | null | no path claim; emit an unknown row |

Warnings use three risk levels instead of a score:

| risk | signals |
| --- | --- |
| `likely` | `apply_patch`, heredoc with a redirect target, in-place edit, inline interpreter with a write API, `git apply`/`patch` |
| `possible` | `rm`/`mv`/`cp`/`install`, `tee`/`dd`/`truncate`, package install, `chmod`, `git` worktree rewrite |
| `noise` | the signal exists only inside a heredoc body or a quoted program, not in shell syntax |

A warning is a coverage unknown. It is never a path claim, and it must never
be capped without returning a way to enumerate the rest.

## 4. Unknown rows

Every opaque call returns one row per reason, not one per path. The row is the
product: it is what lets another agent resolve the gap without an LLM.

```json
{
  "claim": "unknown",
  "reason": "unparsed-exec",
  "risk": "likely",
  "scope": "inside",
  "tool": "exec",
  "seq": 42,
  "line": 128,
  "callId": "call_...",
  "checks": ["apply_patch=patch stored in a local variable", "write-signal"],
  "hints": ["/repo/src/renderer.ts"],
  "explanations": [
    "dvdst did not expand this exec script (patch stored in a local variable), so it makes no nested tool-call claims.",
    "The script contains an apply_patch call, so a file mutation is stated in the text but not attributed to a path."
  ],
  "resolve": [
    "dvdst call --ref <ref> --limit 4000",
    "git diff -- /repo/src/renderer.ts"
  ]
}
```

Reason codes and their explanations:

| reason | explanation | hints |
| --- | --- | --- |
| `inline-interpreter` | an inline `python`/`node` script can write any file; the command text names none | literals bound to a write API, shell targets |
| `git-apply` | the patch applies paths recorded in a diff, not in the command | the patch file, if named |
| `computed-path` | the target is built at run time and cannot be named statically | none |
| `xargs-or-find-exec` | a nested command decides the target | none |
| `unparsed-exec` | the exec script uses bindings, loops, or a computed patch, so dvdst does not expand it | patch headers, shell targets, write-API literals |
| `stdin-input` | input is fed to a running process; that process can write | none |
| `not-modelled-tool` | the tool takes a file path but dvdst does not model its semantics (`NotebookEdit`, `MultiEdit`, MCP tools) | the path argument |
| `sidechain-excluded` | Claude subagent entries are excluded from the canonical stream | the raw sidechain line |
| `warnings-truncated` | more warnings exist than the report shows | the count and a query to enumerate |

`sidechain-excluded` is detected from the raw Claude file. `warnings-truncated`
belongs to the stage report; the reference extractor does not read stage
reports.

`hints` are candidate paths, never claims. A hint is included only when the
text shows write intent: a path literal used with a write API, a shell
redirect target, or an `apply_patch` file header. A path that is only read is
not a hint.

## 5. Coverage row

The per-claim bands answer "is this claim accurate?". They do not answer "is
this the whole change set?". Emit one extra row per session:

| band | score | condition |
| --- | ---: | --- |
| `complete` | 1.00 | no unknown rows and no sidechain |
| `near-complete` | 0.75 | unknowns exist, but no hint names a path inside the cwd |
| `partial` | 0.50 | at least one hint names a path inside the cwd |
| `unknown` | 0.20 | a write-capable unknown is inside the cwd and no hint names any path |

`complete` means complete against the recorded calls. It is not proof that no
unrecorded process touched the worktree.

Contradicted claims do not lower coverage. They are excluded from change
evidence, and the coverage row names the count.

## 6. Measured result

Applying the reference extractor to the 500-session corpus:

Mutation claims (Claude + Codex):

| band | Claude | Codex |
| --- | ---: | ---: |
| verified | 173 | 0 |
| declared | 0 | 1,429 |
| inferred | 431 | 170 |
| partial | 7 | 43 |
| weak | 0 | 8 |
| contradicted | 1 | 1 |

Codex `apply_patch` has no verified band because its success result is `{}`.
Claude has no declared band because every successful direct edit echoes its
path.

Unknown rows:

| source | rows |
| --- | ---: |
| Claude shell | 1,044 |
| Codex shell | 1,431 |
| Codex exec | 994 |
| Codex `write_stdin` | 1 |

Across all sources, 1,669 of 5,124 unknown rows carry at least one path hint.

Coverage:

| source | complete | near | partial | unknown |
| --- | ---: | ---: | ---: | ---: |
| Claude (56) | 6 | 3 | 44 | 3 |
| Codex (122) | 14 | 12 | 79 | 17 |
| Pi (322) | 92 | 36 | 47 | 147 |

More than 80% of Claude and Codex sessions have an incomplete attributed
change set. That is the normal case, not an edge case. A tool that reports
"these are the changed files" without the coverage row is overstating what the
transcript contains.

## 7. Minimum core changes

The extractor proves the ruleset. Folding it into core needs four small,
testable changes:

1. **Outcome on `calls.mutates`.** Do not populate `mutates` for a failed
   declared tool. Add the `partial` distinction for failed shell calls instead
   of treating both the same.
2. **Signal on unparsed exec.** Give `exec` rows
   `opaque: ["unparsed exec script"]`, plus hints, instead of the current empty
   arrays. This is the single largest silent gap: 2,439 rows.
3. **Warnings on shell syntax.** Run signal detection on heredoc-stripped,
   quote-aware text. Return every warning or a cursor, not a silent cap at 20.
4. **Explanation field on stage conflicts.** `Delete`, `Move`, and tracked
   whole-file writes already produce conflicts; their reason should name the
   missing pre-image and the path-scoped check that would resolve it.

A `sourceTool` field (the agent's original name) would also preserve
`MultiEdit` and `NotebookEdit` through Claude canonicalization. The canonical
`edit` row currently hides them.

## 8. Limits

- Every band is evidence from the transcript. A successful tool result is the
  agent's own report, not an independent filesystem read.
- `verified` is only about the named path. It does not prove content
  correctness, absence of other writes, or acceptance.
- A failed shell command can write before it fails. `contradicted` is reserved
  for a write error that names the path, not for every nonzero exit.
- An unparsed exec may call a tool outside the known read-only set. The
  extractor treats that as `possible`, not as "no write".
- Claude sidechain entries are excluded from the canonical stream. No sidechain
  appeared in the 161 Claude sessions inspected, but vanilla Claude Code can
  record them. Detect them from the raw file and emit `sidechain-excluded`.
- Warning hints are static text. A hint can name a path the script only reads.
  It is not a claim.
