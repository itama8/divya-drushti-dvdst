#!/usr/bin/env bash
# Smoke test for the dvdst store pipeline.
# Runs typecheck + unit tests, then exercises ingest -> normalize -> inspect
# on the fixture session and live -> export -> ingest -> timeline on a
# synthetic live stream. Fails loudly when a step breaks.
set -euo pipefail
cd "$(dirname "$0")/.."

STORE="${DVDST_SMOKE_STORE:-$(mktemp -d)}"
LIVE_FILE="$STORE/live-events.jsonl"
EVIDENCE_FILE="$STORE/live-evidence.jsonl"
FIXTURE=test/fixtures/skill-session.jsonl
cleanup() { [[ "${DVDST_SMOKE_KEEP:-0}" != "1" ]] && rm -rf "$STORE"; }
trap cleanup EXIT

step() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

step "1. typecheck + unit tests"
npm run typecheck
npm test 2>&1 | tail -3

step "2. ingest the fixture session (first run)"
npm run --silent dvdst -- ingest "$FIXTURE" --store "$STORE"

step "3. re-ingest the same file (must report unchanged)"
npm run --silent dvdst -- ingest "$FIXTURE" --store "$STORE" \
  | jq -e 'select(.status == "unchanged" and .change.class == "unchanged")' > /dev/null \
  && echo "OK: unchanged, no duplicate snapshot"

step "4. normalize the fixture into derived records"
npm run --silent dvdst -- normalize "$FIXTURE" --store "$STORE" \
  | jq -e 'select(.status == "complete" and .counts.entries == 8 and .counts.toolInvocations == 3 and .orphans.calls == 0)' > /dev/null \
  && echo "OK: 8 entries, 3 tool calls, 3 results, zero orphans"

SNAPSHOT="$(ls -d "$STORE"/sessions/pi/fixture-session/snapshots/*/)"

step "5. inspect the normalized records (jq recipes)"
echo "-- messages --"
jq -c '{entryId, role, text: (.text | .[0:60])}' "$SNAPSHOT/records/messages.jsonl" | head -3
echo "-- tool invocations --"
jq -c '{toolCallId, name}' "$SNAPSHOT/records/tool-invocations.jsonl"
echo "-- timeline --"
jq -rc '[.sequence, .type, (.role // "-")] | @tsv' "$SNAPSHOT/records/timeline.jsonl"

step "6. synthetic live stream: live -> export"
printf '%s\n' \
  '{"schemaVersion":1,"source":"pi.extension","sessionId":"demo-1","sequence":0,"observedAt":"2026-08-19T00:00:00.000Z","type":"session.started","data":{"cwd":"/tmp/demo"}}' \
  '{"schemaVersion":1,"source":"pi.extension","sessionId":"demo-1","sequence":1,"observedAt":"2026-08-19T00:00:01.000Z","type":"message.finalized","data":{"message":{"role":"user","content":[{"type":"text","text":"Fix the docs"}]}}}' \
  '{"schemaVersion":1,"source":"pi.extension","sessionId":"demo-1","sequence":2,"observedAt":"2026-08-19T00:00:02.000Z","type":"tool.started","data":{"toolCallId":"c1","toolName":"bash","args":{"command":"npm test"}}}' \
  '{"schemaVersion":1,"source":"pi.extension","sessionId":"demo-1","sequence":3,"observedAt":"2026-08-19T00:00:03.000Z","type":"tool.finished","data":{"toolCallId":"c1","toolName":"bash","isError":false,"result":{"content":[{"type":"text","text":"pass 30/30"}]}}}' \
  > "$LIVE_FILE"
npm run --silent dvdst -- live --input "$LIVE_FILE" > "$EVIDENCE_FILE"
jq -e 'length > 0' "$EVIDENCE_FILE" > /dev/null && echo "OK: $(wc -l < "$EVIDENCE_FILE") evidence records"
npm run --silent dvdst -- export --input "$EVIDENCE_FILE" --format markdown | head -12

step "7. store the live stream: ingest --live -> timeline"
npm run --silent dvdst -- ingest --live "$LIVE_FILE" --store "$STORE" \
  | jq -e 'select(.status == "ingested" and .events == 4)' > /dev/null \
  && echo "OK: live snapshot stored"
npm run --silent dvdst -- timeline --store "$STORE" --source pi.extension --session demo-1 --kind tool.finished \
  | jq -e 'select(.kind == "tool.finished" and .sequence == 3)' > /dev/null \
  && echo "OK: timeline query returns the finished event"

step "8. probe + inspection commands (baseline CP0)"
npm run --silent dvdst -- files "$FIXTURE"
npm run --silent dvdst -- trace "$FIXTURE" --id run-test | head -3

step "9. deterministic events + findings from a stored session"
npm run --silent dvdst -- events "$FIXTURE" --store "$STORE" \
  | jq -e 'select(.status == "complete" and .counts.commandSucceeded == 1 and .findings.modifiedWithoutObservedRead == 1)' > /dev/null \
  && echo "OK: one succeeded command, one modified-without-read finding"
echo "-- findings --"
jq -c 'select(.kind | startswith("finding")) | {kind, path, label}' "$SNAPSHOT/events/deterministic.jsonl"
echo "-- command outcome events --"
jq -c 'select(.kind == "command-succeeded") | {kind, command}' "$SNAPSHOT/events/deterministic.jsonl"

step "done"
if [[ "${DVDST_SMOKE_KEEP:-0}" == "1" ]]; then
  echo "store kept at: $STORE"
fi