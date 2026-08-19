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
that path appeared earlier in the session.

```json
{
  "kind": "finding-file-modified-without-observed-read",
  "confidence": "inferred",
  "path": "src/new.ts",
  "firstMutationLine": 7,
  "unconfirmedReadRequests": 0,
  "limit": "absence of a read in this session does not prove the agent had no prior knowledge of the file"
}
```

A write that creates a new file naturally triggers this finding. The
`unconfirmedReadRequests` field counts read calls of that path that had no
confirmed success, so a reviewer can tell an unexplained edit from a new file.

### tests-not-run-after-final-mutation

The session confirmed at least one file mutation, and no test command was
observed after the final mutation.

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
