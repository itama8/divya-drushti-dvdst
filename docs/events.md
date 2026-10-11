# Deterministic events

Normalized records preserve source facts. Tool artifacts give them tool-specific
shape. The event extractor turns those artifacts into a compact, deterministic
stream of what the extractor believes the session means: command outcomes,
file activity, and derived findings that point a reviewer at material risks.

The extractor never reads the raw transcript. It reads the artifact streams, so
an event can always be traced back to its source line through the artifact's
`source` reference.

## Command

```bash
npm run --silent dvdst -- events <session.jsonl> --store .dvdst/store
```

or against a stored session:

```bash
npm run --silent dvdst -- events --store .dvdst/store --session <id>
```

The command ingests, normalizes, and extracts artifacts only when the snapshot
does not already have them, then writes two files into the snapshot:

- `events/deterministic.jsonl` - one event or finding per line
- `derived-events.json` - extractor summary with counts and diagnostics

Every record carries `schemaVersion`, `kind`, `confidence`, and either `source`
for observed events or an `evidence` reference for findings.

## Event kinds

Observed events reflect a tool result that the session recorded. Their
confidence is `observed`.

| kind | meaning |
| --- | --- |
| `command-succeeded` | a bash command reported a non-error result |
| `command-failed` | a bash command reported an error result |
| `file-read` | a read call for a path; `observed` is true when a result exists |
| `file-mutation` | an edit or write for a path; `observed` is true when a result exists |

A command artifact with no tool result emits no success or failure event. It
stays visible in the count and diagnostics instead.

File records keep the distinction between a *request* and an *observed result*:
`observed: false` means the call exists but no result was recorded, so the
outcome is unknown.

## Findings

Findings are derived claims. Their confidence is `inferred`, and each one states
its rule, its limit, and the evidence it used. They are appended after the
observed events in the same file.

### file-modified-without-observed-read

A file was mutated (edit or write reported success) and no successful read of
that path appeared earlier in the session. A read is a `read` call or a
successful bash command whose text names the file, such as `cat`, `sed -n`,
or `rg` with the file as an operand.

```json
{
  "kind": "finding-file-modified-without-observed-read",
  "confidence": "inferred",
  "path": "src/new.ts",
  "operation": "write",
  "firstMutationLine": 7,
  "unconfirmedReadRequests": 0,
  "limit": "absence of a read in this session does not prove the agent had no prior knowledge of the file; a write may create the file, and a bash command may read it in a way its text does not show"
}
```

A write that creates a new file naturally triggers this finding. `operation`
is the first mutation of the path, so `select(.operation == "edit")` keeps the
cases where the agent changed existing text it was never shown. The
`unconfirmedReadRequests` field counts read calls of that path that had no
confirmed success.

Both file findings cover the project the session worked on. They leave out
paths outside the session cwd, such as scratch files in `/tmp`, and paths the
project excludes in its [configuration](#project-rules).

### tests-not-run-after-final-mutation

The session confirmed at least one file mutation, and no test command was
observed after the final mutation. A test command is a bash command that the
built-in rules or the [project rules](#project-rules) classify as `test`.

```json
{
  "kind": "finding-tests-not-run-after-final-mutation",
  "confidence": "inferred",
  "finalMutationPath": "src/x.ts",
  "finalMutationLine": 11,
  "testsSeen": true,
  "lastTestCommand": "npm test",
  "lastTestLine": 7,
  "limit": "a missing or earlier test run does not prove the final state is broken; it flags unverified final changes"
}
```

`testsSeen` distinguishes a session that ran no tests at all from one whose last
test preceded the final change. A session with no confirmed mutations produces
no finding.

### unresolved-command-failure

A command failed and no later run of the exact same command text in the session
succeeded.

Retry matching is deliberately conservative: it compares the trimmed command
text byte for byte and accepts only a later success as a resolution. A modified
command is never treated as a retry of an earlier failure.

```json
{
  "kind": "finding-unresolved-command-failure",
  "confidence": "inferred",
  "command": "npm run typecheck",
  "failedAttempts": 1,
  "firstFailureLine": 13,
  "lastFailureLine": 13,
  "lastFailureToolCallId": "typecheck-fail",
  "limit": "exact-text retry matching cannot recognize a retry that modified the command"
}
```

## Bash file effects

Agents read and change files through bash as often as through the dedicated
tools. The artifact extractor parses each bash command and writes
`artifacts/bash-file-effects.jsonl`, one record per file the command text
names:

```json
{
  "kind": "bash-file-effect",
  "confidence": "inferred",
  "effect": "read",
  "via": "sed",
  "path": "src/app.ts",
  "resolvedPath": "/work/app/src/app.ts",
  "toolCallId": "call-12",
  "succeeded": true
}
```

`effect` is `read` or `mutation`, and `via` names the command or shell feature:
`cat`, `sed`, `rg`, `git show`, `sed -i`, `redirect`, `rm`, and so on. The
parser follows literal `cd` steps, ignores heredoc bodies, and skips any path
that needs expansion. A search counts as a read only when an operand names a
file, not a directory.

The record is an inference from the command text. `succeeded` reports the
whole command, not the one step. A script may touch files its text never
names. `dvdst calls` reports those cases per call in `opaque`, for example
`inline node script`.

## Project rules

A project states its own rules in `.dvdst/config.json`, in the directory the
session ran in:

```json
{
  "commandClasses": [
    { "name": "test", "pattern": "\\bnode\\s+scripts/[\\w.-]+-contract\\.mjs\\b", "reason": "contract script" }
  ],
  "findings": { "ignorePaths": ["^\\.devlog/"] }
}
```

The built-in classes are `test`, `typecheck`, `build`, `lint`, `dependency`,
and `inline-script`, a script typed into the command such as `node -e` or a
python heredoc.

- `commandClasses` adds command classes. `pattern` is a regular expression
  tested against the whole command. The rules apply after the built-in ones,
  and a class name may be new.
- `findings.ignorePaths` lists regular expressions tested against the path
  relative to the session cwd. The file findings leave those paths out.

The file is found through the session, so a session is classified the same way
from any working directory. `--config <file>` names another file. Derived
output records the path and SHA-256 of the file that applied, and `dvdst
events` re-extracts a snapshot whose artifacts came from other rules. A file
that exists but is invalid stops the command.

## jq recipes

All recipes read `events/deterministic.jsonl` from a snapshot. Use the
`snapshot` field from the `dvdst events` result line, or the latest snapshot
directory for a session:

```bash
SID=fixture-session   # the session id from the header
LATEST=$(jq -r .sourceHash .dvdst/store/sessions/pi/$SID/latest.json)
EV=".dvdst/store/sessions/pi/$SID/snapshots/$LATEST/events/deterministic.jsonl"
```

List every observed event in source order, with its kind and command or path:

```bash
jq -c 'select(.confidence == "observed") | {kind, command, path}' "$EV"
```

Which files were changed but never read first?

```bash
jq -c 'select(.kind == "finding-file-modified-without-observed-read") | {path, firstMutationLine}' "$EV"
```

Final changes that have no later test run:

```bash
jq -c 'select(.kind == "finding-tests-not-run-after-final-mutation") | {finalMutationPath, finalMutationLine, testsSeen}' "$EV"
```

Commands that failed and were never retried to success:

```bash
jq -c 'select(.kind == "finding-unresolved-command-failure") | {command, failedAttempts, lastFailureLine}' "$EV"
```

Every failed command, including ones later resolved (join observations with
findings by command text):

```bash
jq -c 'select(.kind == "command-failed") | {command, resultBytes}' "$EV"
```

## Determinism and idempotence

The extractor walks artifacts in source order and sorts emit events by source
line, so output depends only on the snapshot content. Re-running the command
rewrites byte-identical files. The findings rules are versioned via the
extractor version in `derived-events.json`; a rule change can replace findings
without touching the artifacts or the raw source snapshot.
