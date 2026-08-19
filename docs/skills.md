# Skill invocations and attribution

Separating skill use from the general transcript is what lets a reviewer see
which instructions a session worked under. The skill extractor detects skill
use from normalized records and labels the records each skill may have
influenced.

## Command

```bash
npm run --silent dvdst -- skills --store .dvdst/store --session <id>
```

The command normalizes the snapshot when needed, then extracts skill streams
and prints the invocation list. Two derived files live in the snapshot under
`records/`:

- `skill-invocations.jsonl` - every detected invocation and load candidate
- `skill-attributions.jsonl` - every attributed record with its labels

## Detection

Pi exposes two skill-loading paths in historical sessions, and the extractor
treats them differently:

| signal | mode | confidence | load status |
| --- | --- | --- | --- |
| expanded `/skill:name` user message | `explicit-command` | `observed` | `expanded` |
| successful `read` of a `SKILL.md` | `model-load-candidate` | `reconstructed` | `loaded` |
| failed or unresolved read of a `SKILL.md` | `model-load-candidate` | `reconstructed` | `failed`/`unconfirmed` |

An explicit skill block is an observed invocation: the session literally
contains the command. A successful `SKILL.md` read is an observed load and a
reconstructed invocation candidate that traced to exact historical content.

Each invocation records the content that was present in the session:

- `contentHash` - SHA-256 of the expanded skill body or the read result text
- `contentBytes` - size of that content
- `loadStatus` - how the content became available
- `loadResult` - source reference for the read that returned the content

The extractor never resolves the currently installed `SKILL.md` and assumes it
matches an old session. The historical content is the only safe source for
versioning.

Failed and unconfirmed reads stay visible in the stream with `loadStatus:
failed` or `unconfirmed` and `activeStartLine: null`, so an ambiguous load never
silently disappears. Consumers that only want active invocations filter them
out; consumers that want to spot missing skills keep them.

## Attribution rule

A successful load proves that instructions entered the conversation. It does
not prove the model followed them. Attribution is therefore conservative: the
inferred span starts at the first assistant record after the load and ends at
the next user message (the end of the same agent turn). Each attributed record
names its basis:

- `explicit-skill-message` - the record is the expanded skill command
- `skill-load` - the record loaded the skill instructions
- `within-turn-window` - the record followed the load within the same agent turn

The default view never labels a later user turn as active skill use. Overlapping
skills keep separate labels instead of erasing each other, so one record can
belong to several invocations at once.

Skill attribution is association, not causation. A cohort built from these
spans can compare skill versions, tool use, failures, tests, and outcomes
across sessions, but it cannot prove that a skill produced an outcome. Treat
the spans as evidence of what was loaded and worked near, never as a measured
effect.

## Views

```bash
npm run --silent dvdst -- skills --store .dvdst/store --session <id> \
  --view invocations|spans|attributions [--format json|tsv]
```

- `invocations` (default) - id, name, mode, confidence, load status, content
  hash and size, turn, and span boundaries
- `spans` - the same invocations reduced to their active line ranges and
  boundary rule
- `attributions` - every attributed message or tool call with its labels

## jq recipes

Point a recipe at the stream:

```bash
LATEST=$(jq -r .sourceHash .dvdst/store/sessions/pi/<id>/latest.json)
BASE=".dvdst/store/sessions/pi/<id>/snapshots/$LATEST/records"
```

Active invocations only (exclude failed and unconfirmed loads):

```bash
jq -c 'select(.loadStatus == "loaded" or .loadStatus == "expanded")' "$BASE/skill-invocations.jsonl"
```

Unique skill versions by content hash:

```bash
jq -r 'select(.contentHash != "") | [.name, .contentHash, .contentBytes] | @tsv' \
  "$BASE/skill-invocations.jsonl" | sort -u
```

Records attributed to one specific invocation (say `doc-check`), by match on
the label array:

```bash
jq -c 'select(.labels | any(.invocationId | contains("doc-check")))' "$BASE/skill-attributions.jsonl"
```

Tool calls that occurred inside any skill span at all, with their tool names:

```bash
jq -c 'select(.recordKind == "tool-call" and (.labels | length > 0))'
```

Join these attributions against `artifacts/commands.jsonl` or
`events/deterministic.jsonl` by `toolCallId` to attribute failures, tests, and
results to a skill. The cookbook in `docs/cookbook.md` shows full join recipes.

## Determinism and idempotence

The extractor reads normalized records in append order and reconstructs turns
deterministically, so re-running it rewrites byte-identical streams. The
attribution rule is versioned through the extractor version in
`derived-skills.json`; changing a boundary rule replaces attribution output
without touching the normalized records or the raw source snapshot.
