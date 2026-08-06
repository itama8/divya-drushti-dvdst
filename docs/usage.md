# How to use dvdst

This guide shows how to run the probe, the handoff, the devlog mapper, the benchmark, and the new narrow inspection commands on real Omakase data.

## 1. Install

```bash
git clone https://github.com/itama8/divya-drushti-dvdst.git
cd divya-drushti-dvdst
npm install
```

The current release is built and validated against Pi sessions from the Omakase development corpus and uses Node.js 22 or newer. It has no runtime dependencies, only `tsx`, `typescript`, and `@types/node` as dev dependencies.

## 2. Validate the build

```bash
npm run typecheck
npm test
```

You should see:

- `npm run typecheck` exit with no errors.
- `npm test` report 11 tests across 5 suites, all passing.

## 3. Run the probe on a real session

Pick a session and a devlog. A real pair is:

```bash
SESSION="$HOME/.pi/agent/sessions/--home-a2ajinkya-Projects-omakase-v2--/2026-08-03T22-23-26-179Z_019fc9b9-83e3-7d68-9d33-db78c83c576f.jsonl"
DEVLOG="/home/a2ajinkya/Projects/omakase-v2/.devlog/2026-08-04-s02.md"
```

Show the full evidence as a single JSON document:

```bash
npm run probe -- --session "$SESSION" --devlog "$DEVLOG" --pretty
```

Or write the full evidence and the focused streams to a directory:

```bash
mkdir -p /tmp/dvdst-out
npm run probe -- --session "$SESSION" --devlog "$DEVLOG" --out /tmp/dvdst-out
ls /tmp/dvdst-out
```

The output directory contains:

- `bundle.json` - the full evidence
- `skills.jsonl` - one skill invocation per line
- `attributions.jsonl` - one attributed record per line, each with its label array
- `commands.jsonl` - one shell command per line with previews and result evidence
- `files.jsonl` - one file path per line with its operation history

Pipe any stream through `jq` for narrow queries:

```bash
jq 'select(.path | startswith("docs/"))' /tmp/dvdst-out/files.jsonl
jq -c 'select(.labels | length > 0)' /tmp/dvdst-out/attributions.jsonl
jq -c 'select(.classes | index("test"))' /tmp/dvdst-out/commands.jsonl
```

## 4. Show a compact handoff summary

The handoff command is what a maintainer or another agent would read first.

```bash
npm run handoff -- --session "$SESSION" --devlog "$DEVLOG"
```

Or request JSON instead of text:

```bash
npm run handoff -- --session "$SESSION" --devlog "$DEVLOG" --format json | jq '{status, outcome, "files": (.files.modified | length), "commands": .commands.total, "skills": .skills.names}'
```

## 5. Generate a draft devlog from a session

When the session did not produce a devlog yet, `handoff-devlog` writes one from the handoff evidence. It derives the frontmatter and an evidence body.

```bash
npm run handoff-devlog -- --session "$SESSION" --out /tmp/dvdst-draft.md \
  --project omakase-v2 \
  --phase docs-spine \
  --checkpoint auto-derived \
  --focus "Recent feature documentation reconciliation" \
  --date 2026-08-04 \
  --session-num 99
head -25 /tmp/dvdst-draft.md
```

The output contains:

- the same frontmatter fields the Omakase devlogs use
- the implementation commit when matched
- a `commit_match_confidence` value derived from matched versus expected commits
- a short evidence body that references the source session

## 6. Discover sessions and inspect narrow streams

Use these commands when you only need a small slice of evidence.

List Pi session files in a directory:

```bash
npm run dvdst -- sessions "$HOME/.pi/agent/sessions/--home-a2ajinkya-Projects-omakase-v2--" --format tsv --limit 3
```

Filter files by path substring:

```bash
npm run dvdst -- files "$SESSION" --path docs/plans
```

List shell commands classified as tests:

```bash
npm run dvdst -- commands "$SESSION" --class test
```

List every skill invocation with its content hash and active line range:

```bash
npm run dvdst -- skills "$SESSION"
```

Look up the provenance of a specific record by its ID:

```bash
npm run dvdst -- trace "$SESSION" --id run-test
```

All four inspection commands support `--format json` for structured pipelines.

## 7. Run the benchmark

The benchmark runs the probe and handoff against three real Omakase cases and writes a markdown report.

```bash
node --import tsx scripts/run-benchmark.mjs
cat docs/benchmark-report.md
```

To add a new case, append it to `scripts/benchmark-cases.json`:

```json
{
  "id": "my-case",
  "session": "/abs/path/to/session.jsonl",
  "devlog": "/abs/path/to/devlog.md",
  "expected": {
    "status": "accepted",
    "phase": "docs-spine",
    "checkpoint": "name-of-checkpoint"
  }
}
```

Then re-run the benchmark. The status field uses the same values the devlog frontmatter uses: `accepted`, `closed`, `stable`, `user-testing`, `blocked`, `regressed`, or `planned`.

## 8. Run a one-off smoke test

The fixture under `test/fixtures/` makes it safe to test without touching real sessions.

```bash
npm run probe -- --session test/fixtures/skill-session.jsonl --devlog test/fixtures/skill-devlog.md --pretty | head -60
npm run handoff -- --session test/fixtures/skill-session.jsonl --devlog test/fixtures/skill-devlog.md
```

## 9. What each file does

| path | purpose |
| --- | --- |
| `src/pi/read-jsonl.ts` | streaming JSONL reader that records line and byte provenance |
| `src/pi/skill-block.ts` | parse explicit `/skill:name` blocks and extract a skill name from `SKILL.md` frontmatter |
| `src/pi/classify-commands.ts` | classify shell commands as test, typecheck, build, or lint |
| `src/pi/extract-commits.ts` | extract commit candidates from command output |
| `src/pi/normalize-paths.ts` | map absolute paths to project-relative paths |
| `src/pi/parse-devlog.ts` | parse Omakase devlog frontmatter |
| `src/pi/sessions.ts` | discover Pi session files in a directory |
| `src/probe/build-bundle.ts` | build the full evidence bundle from a session and optional devlog |
| `src/handoff/summary.ts` | reduce the bundle to a compact handoff summary and text view |
| `src/devlog/format-devlog.ts` | map a handoff summary back to an Omakase devlog draft |
| `src/cli/probe.ts` | CLI for the full probe and JSONL streams |
| `src/cli/handoff.ts` | CLI for the compact summary |
| `src/cli/handoff-devlog.ts` | CLI for the devlog mapper |
| `src/cli/sessions.ts` | CLI to list Pi session files |
| `src/cli/records.ts` | CLI for files, commands, and skills streams |
| `src/cli/trace.ts` | CLI to look up the provenance of a single record |
| `src/cli/dvdst.ts` | dispatcher that routes every subcommand |
| `scripts/run-benchmark.mjs` | run all benchmark cases and write the report |
| `scripts/benchmark-cases.json` | list of real Omakase sessions used by the benchmark |
| `docs/benchmark-report.md` | latest benchmark output |
| `docs/cp0-benchmark.md` | narrative summary of the CP0 product proof |
