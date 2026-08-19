# CP0 benchmark

## Goal

Test whether deterministic extraction can produce useful Omakase handoff evidence with less context than a raw Pi session.

This benchmark now covers ten Omakase sessions with varied outcomes, including four sessions that used explicit `/skill:` commands and one planning session that produced no code changes.

## Case 1: recent documentation reconciliation

### Inputs

- Pi session: `019fc9b9-83e3-7d68-9d33-db78c83c576f`
- Omakase devlog: `.devlog/2026-08-04-s02.md`
- Outcome: accepted documentation reconciliation

The devlog provides candidate labels. The Pi session and Git output provide supporting evidence.

### Extracted evidence

The probe found:

- 105 messages
- 65 tool calls and 65 tool results
- 31 distinct file paths
- 13 shell commands
- 5 skill-load candidates
- 159 distinct skill-attributed records
- 400 skill-to-record attribution memberships

The skill-load candidates were:

- `omakase-session-orient`
- `doc-writer`
- `omakase-checkpoint-map`
- `omakase-session-handoff`
- `omakase-checkpoint-closeout`

Each candidate records the observed `SKILL.md` content hash. The probe attributes later records only within the same user turn.

### Devlog comparison

The probe matched all 15 `contracts_touched` paths against observed `edit` or `write` calls.

It also matched the implementation commit:

```text
75dcc403093a83779828ba3d1e10b440e36415ac
```

The probe reported the devlog itself as one additional observed mutation. This is correct because `contracts_touched` describes the implementation scope rather than the closeout log.

### Context reduction

- source session: 687,118 bytes
- evidence bundle: 103,875 bytes
- handoff summary: about 1,200 bytes
- output size: about 0.2 percent of the source for the summary
- reduction: about 573 times smaller for the summary

The summary fits in a short follow-up context. Detailed streams stay on disk and are loaded only when needed.

## Findings

1. The source contains enough evidence to recover file mutation scope and the implementation commit for this case.
2. Project-relative path normalization is required before comparison with devlogs.
3. Skill reads are easy to detect, but they remain invocation candidates rather than proof of adherence.
4. Overlapping skill labels create many attribution memberships.
5. A compact summary must reference detailed attribution records instead of embedding all of them.
6. The devlog cannot serve as ground truth without transcript and Git verification.
7. Commit dedup must prefer full 40-character hashes over short prefixes to avoid duplicate matches.
8. The handoff correctly reports `no-test-evidence` when the session ran no tests.

## Streams produced

The probe writes the following to the output directory:

- `bundle.json` - full evidence
- `skills.jsonl` - skill invocations
- `attributions.jsonl` - attributed records
- `commands.jsonl` - shell command details
- `files.jsonl` - file activity summary

The handoff command writes a short text or JSON summary derived from the same evidence.

## Ten-case benchmark

The benchmark script reads `scripts/benchmark-cases.json`, runs each case through the probe and handoff, and writes `docs/benchmark-report.json` and `docs/benchmark-report.md`. The report now includes bundle and summary sizes, estimated tokens, and a context-reduction table.

| id | status (obs/exp) | outcome | modified | cmds | failed | tests | commits matched | skills | source bytes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| docs-reconciliation | accepted / accepted | no-test-evidence | 16 | 13 | 0 | 0 | 1 | 5 | 687118 |
| sushi-reference | closed / closed | unresolved-failure | 24 | 38 | 3 | 8 | 1 | 6 | 889578 |
| move-website | accepted / stable | unresolved-failure | 7 | 20 | 1 | 0 | 0 | 1 | 197264 |
| invocation-ux-ut | user-testing / user-testing | no-test-evidence | 20 | 42 | 0 | 0 | 1 | 1 | 948426 |
| nested-scroll-acc | accepted / accepted | no-test-evidence | 5 | 21 | 0 | 0 | 1 | 2 | 377688 |
| cursor-regression | closed / closed | unresolved-failure | 5 | 91 | 5 | 0 | 1 | 4 | 881870 |
| frozen-invocation | closed / closed | unresolved-failure | 10 | 90 | 1 | 10 | 2 | 4 | 2866395 |
| cp38-plan | planned / planned | no-test-evidence | 3 | 17 | 0 | 0 | 0 | 2 | 547854 |
| glassy-background | closed / closed | unresolved-failure | 2 | 24 | 1 | 0 | 0 | 3 | 2623806 |
| invocation-card-position | accepted / stable | no-test-evidence | 10 | 42 | 0 | 0 | 2 | 2 | 3509340 |

Findings:

- All ten sessions match their devlog status after classifying `stable` as accepted.
- Four sessions used explicit `/skill:` commands and appear in the skills column with their detected skill counts.
- The cp38-plan case is a planning session: no commits and no contract matches are expected because the session produced a plan, not code. It exercises the `planned` status path.
- A blocked session was not added because the blocked devlog (`2026-06-19-s04`) has no session in the local corpus that demonstrably wrote it; adding an unverified pair would weaken the benchmark. The planning case stands in for a session that ended without validated code.
- Context reduction from source to the compact summary ranges from about 82× (planning session with a long written plan) to over 1100× for large implementation sessions.
- The handoff devlog mapper renders valid frontmatter with derived confidence values.

## Next steps

1. Add a verified blocked or regressed session once a reliable session/devlog pair exists in the corpus.
2. Replace the byte/4 token estimate with a real tokenizer when one is added as a dependency.
3. Evaluate commit matches against repository Git objects instead of transcript-extracted candidates only.
