# Evidence model

## Goal

Define a filesystem model that preserves Pi source records and supports narrow JSONL queries.

The model must keep observed facts separate from derived claims.

## Record classes

### Source records

Source records preserve facts from the producer with minimal change.

Examples:

- session header
- entry
- message
- content block
- tool call
- tool result
- compaction
- branch relation

### Normalized artifacts

Normalized artifacts give tool-specific structure to source records.

Examples:

- file read
- file mutation
- search
- shell command
- command output
- test run
- skill invocation
- skill-attribution span

A normalized artifact must cite the source records that support it.

### Derived events

Derived events state what an extractor believes the evidence means.

Examples:

- command failed
- test passed
- file modified without an observed prior read
- decision made
- checkpoint completed

Each event must identify its extractor, extractor version, confidence class, and evidence references.

## Confidence classes

Use a small fixed vocabulary:

- `observed`: a source record states the fact directly
- `reconstructed`: deterministic processing rebuilt the fact from complete observed inputs
- `inferred`: deterministic or semantic processing proposed the fact from incomplete evidence

Confidence does not replace provenance. Every record still needs evidence references.

## Identity

Use stable logical IDs for records and content hashes for large payloads.

A logical ID should include:

- adapter name
- source session ID
- source entry ID or source position
- block or artifact position when required

Do not use a content hash as the only record ID. Equal content can occur at different points in one session.

Store large payloads in a shared content-addressed blob directory with SHA-256 names.

## Proposed store layout

```text
store/
├── store.json
├── blobs/
│   └── sha256/<prefix>/<hash>
└── sessions/
    └── pi/<session-id>/
        ├── manifest.json
        ├── source/
        │   ├── raw.jsonl
        │   └── source-state.json
        ├── records/
        │   ├── entries.jsonl
        │   ├── messages.jsonl
        │   ├── tool-invocations.jsonl
        │   ├── tool-results.jsonl
        │   ├── skill-invocations.jsonl
        │   ├── skill-attributions.jsonl
        │   └── timeline.jsonl
        ├── artifacts/
        │   ├── file-reads.jsonl
        │   ├── file-mutations.jsonl
        │   ├── searches.jsonl
        │   ├── commands.jsonl
        │   └── tests.jsonl
        └── events/
            └── deterministic.jsonl
```

The exact file list can change during the first fixture implementation. The separation between source, artifacts, and events must remain.

## Manifest

The manifest should record:

- evidence schema version
- adapter and adapter version
- source session ID and source version
- source path and working directory
- source size, modification time, and hashes
- ingestion time
- ingestion status and diagnostics
- record and artifact counts
- known source gaps
- extractor runs

A manifest must not claim complete ingestion when malformed or unsupported records remain.

## Timeline

The timeline preserves source append order. Each item should reference its normalized records and artifacts.

Branch ancestry belongs in explicit fields:

- `sourceEntryId`
- `parentSourceEntryId`
- `branchDepth`, if calculated
- `isOnSelectedBranch`, only when a branch selection rule exists

The adapter must not discard abandoned branches.

## Provenance reference

A provenance reference should identify:

- session ID
- source entry ID
- content block or field path when relevant
- source line number
- source byte range when available

Byte ranges make it possible to verify a compact record without parsing the full source again.

## File activity rules

File activity must separate these facts:

- the agent requested a read
- the tool returned a range
- the agent requested a mutation
- the tool reported success or failure
- a patch can be reconstructed from tool arguments
- repository state confirms a net change

Use distinct fields instead of one `modified: true` flag.

A final session diff is exact only when `dvdst` has trustworthy before and after repository states. Transcript-only ingestion can emit observed mutation records without claiming an exact final diff.

## Skill invocation and attribution rules

Pi exposes two skill-loading paths in historical sessions:

- An explicit `/skill:name` command becomes a user message with a `<skill>` block.
- A model-selected skill usually appears as a `read` call for its `SKILL.md` file.

Treat an explicit skill block as an observed invocation. Treat a successful `SKILL.md` read as an observed load and a reconstructed invocation candidate.

Do not treat a skill mention as an invocation. Do not resolve the current file and assume it matches historical instructions.

A skill invocation should record:

- skill name
- source path
- invocation mode
- source entry and tool-call references
- supplied arguments when present
- loaded content hash
- start boundary
- end boundary and boundary rule
- attribution confidence
- parent invocation when skills overlap or nest

Use the content present in the session to identify the invoked skill version. If the source only records a partial or truncated skill body, record that limitation.

Historical sessions do not state when a model stops following a skill. Attribution is therefore different from causation.

Each attributed message or tool call should record one of these bases:

- `explicit-skill-message`: the record is the expanded skill command
- `skill-load`: the record loaded the skill instructions
- `within-turn-window`: the record followed the load within the same agent turn
- `within-declared-span`: future instrumentation declared start and end boundaries
- `self-declared`: the assistant explicitly associated the record with the skill

The default historical rule should end an inferred active span at the next user message. A consumer can request a wider loaded-context view, but that view must not claim active adherence.

Records can reference multiple invocations. Keep overlap instead of forcing one exclusive skill label.

### Skill benchmark recipe

Use one invocation as the basic analysis unit. Group invocations by skill name and loaded content hash.

Measure separate dimensions:

- selection: whether the agent loaded the skill for a matching task
- adherence: whether evidence satisfies skill-specific process checks
- cost: tokens, elapsed time, messages, and tool calls
- reliability: errors, retries, validation, and unresolved failures
- outcome: user acceptance or another external result label

A historical cohort can compare associations across skill versions, models, and task classes. It cannot establish that the skill caused an outcome.

For an effectiveness claim, use matched or controlled runs. Pin the task, repository state, model, provider, reasoning level, and available tools where practical. Compare runs with and without the skill, or compare two content hashes of the same skill.

Keep raw measurements separate from aggregate scores. A recipe must disclose missing data, attribution rules, cohort filters, and outcome-label sources.

## Command and test rules

A command artifact should record:

- command text
- working directory
- call and result references
- exit status when present
- cancellation and truncation state
- stdout and stderr blob references when separable
- start and end times when present
- classification and classifier version

A test record is a derived artifact from a command. The original command remains the source of truth.

## Schema evolution

Every JSONL record should carry a schema version or belong to a file with a declared schema version.

Readers must reject unsupported major versions. Readers can accept new optional fields within a supported major version.

Re-ingestion can replace normalized outputs. It must not alter the retained raw source for that source snapshot.

Skill attribution rules are versioned extractors. A new boundary rule can replace attribution output without changing source or invocation evidence.

## CLI stream rules

Commands that emit records must:

- write one JSON object per stdout line
- write diagnostics to stderr
- return a nonzero status for failed operations
- avoid progress text on stdout
- accept JSONL from stdin where composition is useful

Human-readable output can use an explicit format flag. JSONL remains the default for evidence streams.
