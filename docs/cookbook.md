# jq cookbook

These recipes turn the evidence store into the narrow answers a maintainer
needs during Omakase closeout. Every command reads canonical JSONL files with
`jq` - no CLI feature is required beyond the extractors that wrote the files.

The recipes are deterministic. Their limits are stated in the output and in the
notes, so an answer never overclaims what the transcript can prove.

## Setup

Point a shell at one session, or loop over all sessions in a store.

```bash
STORE=.dvdst/store
# latest snapshot of one session
base() { echo "$STORE/sessions/pi/$1/snapshots/$(jq -r .sourceHash "$STORE/sessions/pi/$1/latest.json")"; }
SID=fixture-session
B="$(base "$SID")"
```

The layout inside a snapshot:

```text
records/   entries, messages, tool-invocations, tool-results, timeline,
           skill-invocations, skill-attributions
artifacts/ file-reads, file-mutations, searches, commands, tests,
           unknown-tools
events/    deterministic
derived*.json    extractor summaries
```

Run the full pipeline on any new session first:

```bash
npm run --silent dvdst -- events <session.jsonl> --store "$STORE"
npm run --silent dvdst -- skills --store "$STORE" --session <id> --format json
```

## 1. Command failures and unresolved retries

Every failed command in a session, in source order:

```bash
jq -c 'select(.kind == "command-failed") | {command, toolCallId}' "$B/events/deterministic.jsonl"
```

Failures never retried to success (conservative exact-text matching):

```bash
jq -c 'select(.kind == "finding-unresolved-command-failure") | {command, failedAttempts, lastFailureLine}'
```

Commits commands that kept failing after several attempts:

```bash
jq -r 'select(.kind == "finding-unresolved-command-failure" and .failedAttempts > 1)
  | [.command, (.failedAttempts|tostring)] | @tsv'
```

## 2. File mutations without an observed prior read

```bash
jq -c 'select(.kind == "finding-file-modified-without-observed-read") | {path, firstMutationLine, unconfirmedReadRequests}'
```

## 3. Final changes that were never verified by a test run

```bash
jq -c 'select(.kind == "finding-tests-not-run-after-final-mutation") | {finalMutationPath, testsSeen, lastTestCommand, lastTestLine}'
```

`testsSeen: false` means the session ran no tests at all; a `lastTestLine`
before `finalMutationLine` means the final change came after the last test run.

## 4. Skill versions by content hash

Versioning is historical: the hash comes from the content present in the
session, never from the currently installed `SKILL.md`.

```bash
jq -r 'select(.contentHash != "") | [.name, .contentHash[0:16], (.contentBytes|tostring), .loadStatus] | @tsv' \
  "$B/records/skill-invocations.jsonl" | sort -u
```

Across a whole store, one line per session (tells you which sessions ran which
version):

```bash
for LATEST in "$STORE"/sessions/pi/*/latest.json; do
  SID=$(basename "$(dirname "$LATEST")")
  H=$(jq -r .sourceHash "$LATEST")
  INV="$STORE/sessions/pi/$SID/snapshots/$H/records/skill-invocations.jsonl"
  [ -f "$INV" ] || continue
  jq -r --arg sid "$SID" '[.name, $sid, .contentHash[0:16], .loadStatus] | @tsv' "$INV"
done
```

A different hash for the same skill name is a different version. Two sessions
that report the same name and hash ran the same instructions.

## 5. Attributed tool activity per skill

Join skill attributions with command artifacts by tool-call id. The result
names every shell command that ran inside a skill span and what the tool
reported.

```bash
jq -n --slurpfile attrs "$B/records/skill-attributions.jsonl" \
      --slurpfile cmds "$B/artifacts/commands.jsonl" '
  ($attrs[] | select(.recordKind == "tool-call")) as $attr
  | ($cmds[] | select(.toolCallId == $attr.recordId)) as $cmd
  | {toolCallId: $cmd.toolCallId, command: $cmd.command,
     isError: (if $cmd.result then $cmd.result.isError else null end),
     classes: [$cmd.classifications[].name],
     skills: [$attr.labels[].invocationId]}'
```

## 6. Validation, failures, and tests attributed to a skill

Command outcomes inside skill spans:

```bash
jq -n --slurpfile ev "$B/events/deterministic.jsonl" \
      --slurpfile attrs "$B/records/skill-attributions.jsonl" '
  ($attrs[] | select(.recordKind == "tool-call")) as $attr
  | ($ev[] | select(.toolCallId == $attr.recordId
        and (.kind == "command-succeeded" or .kind == "command-failed"))) as $e
  | {kind: $e.kind, command: $e.command, skills: [$attr.labels[].invocationId]}'
```

Test runs that happened inside a skill span:

```bash
jq -n --slurpfile attrs "$B/records/skill-attributions.jsonl" \
      --slurpfile tests "$B/artifacts/tests.jsonl" '
  ($attrs[] | select(.recordKind == "tool-call")) as $attr
  | ($tests[] | select(.toolCallId == $attr.recordId)) as $t
  | {toolCallId: $t.toolCallId, command: $t.command,
     isError: (if $t.result then $t.result.isError else null end),
     skills: [$attr.labels[].invocationId]}'
```

Aggregate one row per skill span (attributed messages, tool calls, commands,
and failed commands) as a coarse cost and reliability proxy:

```bash
jq -n --slurpfile attrs "$B/records/skill-attributions.jsonl" \
      --slurpfile cmds "$B/artifacts/commands.jsonl" '
  reduce ($attrs[] | select(.recordKind == "tool-call")) as $attr
    ({}; .[$attr.labels[].invocationId] += 1) as $toolCounts
  | $attrs[] | select(.recordKind == "tool-call") as $attr
  | reduce ($cmds[] | select(.toolCallId == $attr.recordId)) as $cmd
    ({}; if $cmd.result then .[($cmd.result.isError|tostring)] += 1 else . end) as $out
  | {invocation: $attr.labels[0].invocationId,
     commandsAttributed: $toolCounts[$attr.labels[0].invocationId],
     failures: ($out["true"] // 0),
     successes: ($out["false"] // 0)}'
```

Keep raw counts separate from any aggregate score. These numbers measure
association between a loaded skill and nearby activity; they cannot prove that
the skill caused the outcome.

## 7. Compare sessions side by side

One compact row per session using the extractor summaries:

```bash
for LATEST in "$STORE"/sessions/pi/*/latest.json; do
  SID=$(basename "$(dirname "$LATEST")"); H=$(jq -r .sourceHash "$LATEST")
  E="$STORE/sessions/pi/$SID/snapshots/$H/derived-events.json"
  S="$STORE/sessions/pi/$SID/snapshots/$H/derived-skills.json"
  [ -f "$E" ] || continue
  jq -n --arg sid "$SID" \
       --slurpfile e <(jq '.counts' "$E") \
       --slurpfile s <(jq '.counts' "$S" 2>/dev/null || echo 'null') '
    {session: $sid,
     commandSucceeded: $e[0].commandSucceeded, commandFailed: $e[0].commandFailed,
     unresolvedFailures: $e[0].findings.unresolvedCommandFailures,
     testsNotRunAfterMutation: $e[0].findings.testsNotRunAfterFinalMutation,
     skills: ($s[0].invocations // 0)}'
done
```

`findings` counts live on `derived-events.json`; the skill counts on
`derived-skills.json`.

## Limits

- A missing read before a mutation is an absence of evidence, not proof that
  the agent was unaware of the file.
- An earlier or absent test run flags unverified final changes; it does not
  prove the final state is broken.
- Untested retry matching compares command text exactly, so a retry that
  changed the command is not recognized as one.
- Skill spans mark where instructions were loaded and what ran nearby. They
  describe association. Controlled effectiveness needs matched runs that pin
  the task, repository state, model, and tool set - these recipes can build the
  cohort, not the experiment.

## Agreeing with the CLI

The recipes and the CLI read the same canonical files. A recipe that disagrees
with `dvdst skills` or `dvdst events` points to a reader bug, not to separate
truth. When a golden fixture changes, update the fixture and re-verify the
recipes that depend on it.
