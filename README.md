# divya-drushti (`dvdst`)

`dvdst` turns coding-agent sessions into structured development evidence.

The first adapter ingests Pi sessions from Omakase. It also accepts append-only live event streams from a running session. The first release exposes messages, tool activity, file activity, commands, tests, skill invocations, attributed skill spans, and provenance as JSONL.

The release is deterministic and local: no runtime dependencies, no model calls, and no network. Re-running an extractor rewrites byte-identical output and never touches the retained raw source snapshot. See [`CHANGELOG.md`](CHANGELOG.md) for the full 0.1.0 surface and [`docs/release.md`](docs/release.md) for the hardening results, compatibility policy, and release checks.

## Quick start

```bash
cd ~/Projects/dvdst
npm install
npm test
```

For concrete commands and real Omakase examples, read [`docs/usage.md`](docs/usage.md).

## Project documents

- [`docs/usage.md`](docs/usage.md) - how to run the probe, handoff, devlog mapper, and benchmark.
- [`docs/cp0-benchmark.md`](docs/cp0-benchmark.md) - product-proof results and ten-case benchmark.
- [`docs/benchmark-report.md`](docs/benchmark-report.md) - latest benchmark output as a table.
- [`docs/project-plan.md`](docs/project-plan.md) - scope, checkpoints, and completion criteria.
- [`docs/pi-session-source.md`](docs/pi-session-source.md) - findings from the Pi source format and the Omakase session corpus.
- [`docs/evidence-model.md`](docs/evidence-model.md) - the first storage and provenance design.
- [`docs/live-streams.md`](docs/live-streams.md) - the live event contract and Pi extension adapter.
- [`docs/session-ingestion.md`](docs/session-ingestion.md) - the session store: snapshots, change detection, and failure safety.
- [`docs/events.md`](docs/events.md) - deterministic events, derived findings, and jq recipes.
- [`docs/skills.md`](docs/skills.md) - skill invocation detection, attribution windows, and queries.
- [`docs/cookbook.md`](docs/cookbook.md) - tested jq recipes for skill versions, attributed tool use, failures, and outcomes.
- [`docs/release.md`](docs/release.md) - corpus hardening results, compatibility policy, and release checks.

## Product boundary

Adapters produce evidence. Extractors produce events. CLI tools expose both. Profiles and recipes consume them.

The canonical evidence store uses files and JSONL. An index can improve queries later, but it does not replace canonical files.

## Complete Omakase evidence workflow

One pass from a raw Pi session to a queryable store, with failure findings and
skill-attributed records:

```bash
SESSION="$HOME/.pi/agent/sessions/--home-a2ajinkya-Projects-omakase-v2--/<session-id>.jsonl"
npm run --silent dvdst -- events "$SESSION" --store .dvdst/store   # ingest + normalize + artifacts + events
npm run --silent dvdst -- skills --store .dvdst/store --session <session-id> --view invocations
npm run --silent dvdst -- skills --store .dvdst/store --session <session-id> --view attributions
LATEST=$(jq -r .sourceHash ".dvdst/store/sessions/pi/<session-id>/latest.json")
BASE=".dvdst/store/sessions/pi/<session-id>/snapshots/$LATEST"
# unresolved command failures and files changed without a prior read
jq -c 'select(.kind | startswith("finding"))' "$BASE/events/deterministic.jsonl"
# every command that ran inside a skill span, joined by tool-call id
jq -n --slurpfile a "$BASE/records/skill-attributions.jsonl" --slurpfile c "$BASE/artifacts/commands.jsonl" \
  '($a[] | select(.recordKind == "tool-call")) as $at | ($c[] | select(.toolCallId == $at.recordId)) as $cmd | {command: $cmd.command, failed: $cmd.result.isError}'
```

For the full store layout, jq recipes, and what each finding means, read
[`docs/events.md`](docs/events.md), [`docs/skills.md`](docs/skills.md), and
[`docs/cookbook.md`](docs/cookbook.md).
