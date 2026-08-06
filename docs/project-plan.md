# Project plan

## Goal

Build a TypeScript CLI that turns Pi sessions into trustworthy, queryable development evidence.

The first product proof is a compact handoff evidence bundle for an Omakase session. The bundle must recover useful facts with less context than the raw transcript.

The first release must ingest the Omakase session corpus and support deterministic, provenance-backed audits without an LLM.

## Scope

### In scope

- recursive Pi session discovery
- Pi session versions found in the Omakase corpus
- branch-aware source normalization
- clean message and tool streams
- tool-specific file, search, command, and test artifacts
- skill invocation records and attributed message or tool spans
- skill benchmarking recipes
- a filesystem evidence store
- content-addressed large payloads
- incremental and repeatable ingestion
- deterministic events and jq recipes
- one compact Omakase handoff evidence bundle
- narrow inspection and provenance commands
- fixtures, schema tests, and corpus smoke tests

### Out of scope for the first release

- a graphical interface
- Hermes profiles
- MCP or an HTTP server
- model-assisted semantic events
- live background watching
- support for non-Pi harnesses
- an SQLite canonical store
- automatic documentation edits
- exact historical repository diffs when the source lacks before and after states

## Product invariants

1. Preserve the raw source used for each ingestion snapshot.
2. Keep source facts, normalized artifacts, and derived events separate.
3. Attach provenance to each normalized artifact and derived event.
4. Never present an inferred change as an exact observed diff.
5. Preserve source append order and branch ancestry.
6. Keep ingestion local and deterministic by default.
7. Emit JSONL on stdout and diagnostics on stderr.
8. Make interrupted ingestion safe to retry.
9. Version schemas and extractors.
10. Let consumers read canonical files without the CLI.
11. Separate skill loading, temporal attribution, instruction adherence, and causal effectiveness.

## Success measures

Measure the project against Omakase maintenance work, not only parser coverage.

### Fidelity

- Every emitted fact traces to source evidence.
- The benchmark records false claims, missed facts, and unsupported certainty.
- Unknown records remain visible instead of disappearing.

### Context reduction

- A handoff consumer starts from a compact bundle instead of a full transcript.
- The benchmark records source bytes, bundle bytes, and estimated tokens.
- Drill-down loads only the evidence needed for one claim.

### Workflow value

- The bundle identifies goals, touched files, commands, failures, tests, commits, and unresolved work when the source supports them.
- A maintainer can draft or verify a handoff from the bundle without rereading the full session.
- The project reduces Pi time or context spent on Omakase closeout work.

### Skill analysis

- Each detected skill invocation identifies its mode, loaded content hash, and evidence.
- Each attributed record states the boundary rule and confidence.
- Benchmarks separate observational associations from controlled effectiveness claims.
- Skill comparisons can group runs by skill name, content hash, model, task class, and outcome.

### Operational cost

- Unchanged sessions do not require full reprocessing.
- Corpus ingestion has measured time, memory, and storage costs.
- Normal ingestion performs no model or network calls.

## Proposed command surface

The first command set should remain small:

```bash
dvdst sessions <path...>
dvdst ingest [session-file...]
dvdst show <session-id> --artifact <type>
dvdst timeline <session-id>
dvdst files <session-id>
dvdst commands <session-id>
dvdst skills <session-id>
dvdst events <session-id>
dvdst trace <record-id>
```

`dvdst sessions` should accept Pi session directories and project directories. It should emit discovered session descriptors.

`dvdst ingest` should accept paths as arguments or session descriptors on stdin. It should write a store and emit ingestion result records.

The inspection commands should read the store. They should emit JSONL by default.

## Checkpoints

### CP0: Product proof and fixture baseline

#### Goal

Prove that compact session evidence helps with Omakase handoffs before freezing a broad evidence schema.

#### Steps

1. Select ten Omakase sessions with corresponding devlogs and varied outcomes.
2. Include model-loaded skills, explicit skill commands, multiple skills, and sessions without skills.
3. Record expected goals, files, commands, failures, tests, commits, skills, and next actions from each pair.
4. Build a disposable probe that extracts these facts from raw Pi JSONL.
5. Compare each evidence bundle with its devlog, source transcript, and relevant Git evidence.
6. Treat devlogs as candidate labels, not ground truth.
7. Record false claims, missed facts, ambiguous facts, bundle size, and source size.
8. Identify which handoff fields require repository or user evidence outside the transcript.
9. Compare skill-load detection and conservative turn attribution with manual labels.
10. Define the minimum provenance and confidence contracts from these results.
11. Add sanitized linear, branched, compacted, malformed, image, skill, and truncated-output fixtures.
12. Define golden output for one small fixture and one representative handoff bundle.

#### Done when

- the ten-session benchmark and its evaluation method are reproducible
- every emitted benchmark fact has a source reference
- the bundle is materially smaller than its source session
- the benchmark shows which handoff fields can and cannot be derived safely
- the user confirms that the bundle would help draft or verify an Omakase handoff
- malformed input produces a structured diagnostic and nonzero status

#### Go or no-go gate

Continue to the general evidence store only if the benchmark reduces context without hiding material uncertainty.

If the bundle does not help, narrow the product to the useful extracted facts. Do not build the broader platform from the handoff alone.

### CP1: Discovery and source ingestion

#### Goal

Discover Pi sessions and preserve a validated raw snapshot in the evidence store.

#### Steps

1. Discover JSONL sessions recursively.
2. Parse and validate each session header.
3. Stream source lines instead of loading a whole file.
4. Record line numbers and byte ranges.
5. Preserve the raw source snapshot.
6. Build source-state hashes that detect append, replacement, and truncation.
7. Write atomically through a temporary session directory.
8. Emit a manifest with complete, partial, or failed status.

#### Done when

- discovery finds the Omakase corpus from its session root
- ingestion handles the largest current Omakase file within a defined memory ceiling
- a repeated unchanged ingestion performs no duplicate work
- an interrupted write leaves the previous store readable
- changed earlier lines force safe re-ingestion

### CP2: Message, tree, and tool normalization

#### Goal

Expose clean conversation records and a complete execution timeline.

#### Steps

1. Normalize all known Pi entry types.
2. Preserve parent links and source append order.
3. Normalize user, assistant, tool-result, and extended message roles.
4. Move large text and image payloads into blob storage.
5. Pair tool calls with results by tool-call ID.
6. Retain orphan calls and orphan results as diagnostics.
7. Represent compaction and branch summaries as source records.
8. Emit messages, tool invocations, tool results, and timeline JSONL.

#### Done when

- no known fixture entry disappears from normalized output
- branches remain queryable without replaying the raw file
- tool calls and results remain independently addressable
- a consumer can read conversation text without embedded large tool payloads
- `dvdst trace` reaches the source line for each normalized record

### CP3: Tool-specific evidence

#### Goal

Turn Pi tool records into useful file, search, command, and test artifacts.

#### Steps

1. Define an adapter registry keyed by tool name and argument shape.
2. Normalize `read`, `edit`, `write`, `bash`, and search tools found in the corpus.
3. Record requested and returned file ranges separately.
4. Reconstruct operation patches only when the source supports them.
5. Store command output as blobs.
6. Classify likely test, build, typecheck, lint, and dependency commands.
7. Record classifier reasons and versions.
8. Represent unknown tools without dropping their calls or results.

#### Done when

- `dvdst files` answers which files were read and mutated
- `dvdst commands` reports command text, result, and truncation state
- test classification is deterministic and reversible
- unsupported tools remain visible in generic records
- mutation records state whether a patch is observed, reconstructed, or inferred

### CP4: Skill invocation and attribution

#### Goal

Separate skill use from the general transcript and label the records that each skill may have influenced.

#### Steps

1. Detect explicit expanded `/skill:name` messages.
2. Detect successful reads of known `SKILL.md` files.
3. Parse skill names and locations from observed content when available.
4. Hash the skill instructions stored in the session.
5. Emit observed invocations for explicit commands and invocation candidates for model loads.
6. Attribute later messages and tool calls with a conservative same-turn rule.
7. Preserve overlapping and nested skill labels.
8. Record the boundary rule and confidence on each attribution.
9. Emit loaded-context views separately from active-invocation views.
10. Add `dvdst skills` queries for invocations, spans, tool use, failures, tests, tokens, and outcomes.

#### Done when

- explicit invocations, observed loads, and inferred invocation candidates remain distinguishable
- each invocation traces to the exact historical skill content
- each attributed record explains why it belongs to the span
- the default view does not label later user turns as active skill use
- overlapping skills do not erase each other
- unsupported or ambiguous skill loads remain visible

### CP5: Deterministic events and cookbook proof

#### Goal

Prove that structured evidence can reduce Omakase maintenance work without a model.

#### Steps

1. Emit deterministic command-failed and command-succeeded events.
2. Emit observed file-read and file-mutation events.
3. Derive modified-without-observed-prior-read findings.
4. Derive tests-not-run-after-final-observed-mutation findings.
5. Derive unresolved-command-failure findings with conservative retry matching.
6. Add jq recipes for each finding.
7. Add recipes that compare skill versions, attributed tool use, validation, failures, and outcomes.
8. Build a compact handoff evidence bundle without prose generation.
9. Test recipes against selected sanitized Omakase sessions.
10. Document that historical skill comparisons show association, not causation.

#### Done when

- every event traces to source evidence
- the CLI and jq recipes agree on golden fixtures
- findings state their limits and do not overclaim
- a handoff consumer can start from a compact bundle instead of raw transcripts

### CP6: Corpus hardening and release

#### Goal

Make the first release reliable across the full local Omakase corpus.

#### Steps

1. Run read-only ingestion against all Omakase sessions.
2. Classify every parse and adapter diagnostic.
3. Add fixtures for each material schema variant.
4. Measure runtime, peak memory, store size, and deduplication ratio.
5. Add private directory permissions and safe cleanup commands.
6. Document installation, store layout, and jq use.
7. Define compatibility policy and release checks.

#### Done when

- every discovered Omakase session either ingests or reports an understood structured diagnostic
- no source file changes during read-only ingestion
- repeated ingestion is deterministic
- release checks pass from a clean checkout
- the README includes one complete Omakase evidence workflow

## First vertical slice

Run the CP0 benchmark before building the general store.

The slice should produce:

```text
one real Omakase session
  -> disposable deterministic extractor
  -> compact handoff evidence bundle
  -> references into the raw session
  -> comparison with the corresponding devlog
```

Support the common Omakase tools first: `read`, `edit`, `write`, and `bash`. Preserve unsupported tools as generic records.

Choose benchmark sessions with skill activity. The probe should identify explicit skill blocks and `SKILL.md` reads, then test conservative same-turn attribution.

Do not optimize branches in this slice. The corpus contains few branched sessions, but the schema fixtures must still prevent a linear-only dead end.

After the product proof passes, implement the narrow CP1 store path for one linear fixture.

## Technical direction

Use TypeScript on a supported Node.js LTS release. Prefer Node built-ins for streams, hashing, paths, and argument parsing.

Add a dependency only when it removes clear implementation or compatibility risk. Runtime schema validation is likely the first justified dependency.

Use SHA-256 for blob identity and source snapshots. Write a session snapshot into a temporary directory, then rename it into place.

Keep adapter code separate from evidence-store code:

```text
src/
├── cli/
├── adapters/pi/
├── evidence/
├── extractors/
├── store/
└── commands/
```

This is a starting boundary, not a package split.

## Validation strategy

Use three test layers:

1. unit tests for schemas, IDs, parsers, and tool adapters
2. golden fixture tests for complete JSONL output
3. read-only corpus smoke tests for compatibility and resource use

Never make normal tests depend on private live sessions. Corpus tests must use an explicit local path and must not run in CI by default.

## Risks

### False diff precision

Historical transcripts cannot always prove exact before and after file states.

Mitigation: label operation evidence by confidence and delay exact final diffs until repository snapshots support them.

### Source schema drift

Pi extensions and future versions can add entry types, message roles, and tool shapes.

Mitigation: preserve unknown records, report adapter coverage, and version the Pi adapter.

### Branch ambiguity

File order and conversational ancestry answer different questions.

Mitigation: preserve both and require an explicit branch rule for active-branch views.

### Sensitive data duplication

A retained raw snapshot creates another copy of private session data.

Mitigation: keep the store local, use private permissions, document its contents, and add explicit cleanup.

### Storage growth

Tool output, images, and repeated source content can make the store large.

Mitigation: deduplicate large payloads by hash and measure amplification during CP5.

### Heuristic test classification

Command text alone can misclassify tests and retries.

Mitigation: retain the command, classifier reason, and classifier version. Treat classification as derived evidence.

### Skill attribution overreach

A successful skill read proves that instructions entered the conversation. It does not prove adherence or causation.

Mitigation: separate loads, invocation candidates, attributed spans, adherence checks, and controlled effectiveness results.

### Skill version drift

The current `SKILL.md` can differ from the content used in an old session.

Mitigation: identify skill versions from session content and store its hash. Do not substitute the current file silently.

## Sense-check findings

The project has a real first user and a large source corpus. Omakase also has a near-sized devlog corpus that can provide candidate evaluation labels.

The devlogs are not ground truth. They were generated during the same development process and can contain omissions or interpretation errors.

The current corpus uses a small tool vocabulary. Most calls use `bash`, `read`, `edit`, or `write`. This makes the first adapter tractable.

Branch and compaction support remain correctness requirements, but they are not the main source of early value. Handoff evidence and command or file audits should come first.

The main product risk is infrastructure without workflow savings. CP0 now tests the handoff use case before the project commits to the full store and event system.

The main evidence risk is false precision. Transcript-observed mutations, Git state, user acceptance, and generated summaries are different evidence sources.

## Open questions

1. Should the raw snapshot copy each full session, or should it use a content-addressed source blob?
2. What Node.js LTS floor should the first public release support?
3. Which runtime schema library gives the best balance of JSON Schema export and low dependency weight?
4. How should a user select an active branch when the latest appended entry is not the desired branch?
5. Should repository correlation use Git objects, explicit snapshots, or both in a later release?
6. Which exact Pi tool-name variants exist across all Omakase sessions?
7. Which records need path normalization across Linux, macOS, and Windows?
8. Should the default inferred skill span end at the next user message or the next completed assistant turn?
9. How should controlled skill benchmarks match task, model, provider, reasoning level, and repository state?

## Done when

The first release is complete when a user can ingest the Omakase Pi corpus and query narrow evidence without opening raw transcripts.

The release must preserve provenance, expose uncertainty, and support useful deterministic reviews through CLI commands and jq.
