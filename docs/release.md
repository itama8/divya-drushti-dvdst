# CP6 hardening and first release

This documents what the first release guarantees after corpus hardening, the
measured run, the compatibility policy, and the release checks.

## Corpus hardening result

Run against the full local Omakase Pi corpus:

```bash
npm run corpus -- ~/.pi/agent/sessions/--home-a2ajinkya-Projects-omakase-v2-- \
  --store .dvdst/store-corpus --report docs/corpus-report.json
```

Measured with Node 25 on the local machine:

| measure | result |
| --- | --- |
| sessions discovered | 396 |
| sessions ingested | 396 |
| failed | 0 on a quiet second run |
| wall time (initial + repeat) | ~6.6s + ~7.4s |
| peak RSS | ~221 MB |
| parse diagnostics | 0 across the whole corpus |
| manifests | 396 `complete` |
| source bytes | 624,055,529 |
| store bytes | 624,647,133 (≈1:1; snapshots are verbatim copies) |

A repeat run reports `unchanged` for 395 of 396 sessions (no writes). The one
session that re-ingested was still being appended to while the first run read
it; dvdst detects the change as an append, keeps the new snapshot, and the
second run is clean. Ingestion is therefore deterministic on quiesced sources.

Sources are read-only to dvdst. The runner hashes a sample of source files
before and after ingestion and fails a run that observes a change. A change
during ingestion means a live Pi session was writing to the file, so a clean
corpus run should be done on quiesced sessions.

The corpus uses a small entry vocabulary, and the normalizer preserves all of
it: `message`, `custom` (rewind-turn), `thinking_level_change`,
`model_change`, `session_info`, `compaction`, and `session`. Content blocks
`text`, `thinking`, `toolCall`, and `image` are kept structural; oversized
blocks move to the shared SHA-256 blob store. Message-level `diagnostics`
(including `provider_transport_failure`) are preserved verbatim on the entry
record.

## Store privacy and cleanup

The canonical store is private by construction:

- store directories are mode `0700`
- store files (`raw.jsonl`, `manifest.json`, JSONL streams) are mode `0600`
- blobs are content-addressed under `store/blobs/sha256/<prefix>/<hash>`

Remove a store without touching sources:

```bash
npm run dvdst -- cleanup --store .dvdst/store --yes
```

Cleanup refuses to remove a directory that lacks the `store.json` marker or a
`--yes` flag. The Pi sessions outside the store are never written by dvdst.

## No network or model calls

Normal ingestion, normalization, artifact extraction, skill attribution, and
event derivation perform only local deterministic computation. There are no
runtime dependencies and nothing in the pipeline calls a model or the network.
The jq cookbook and CLI agree on the same canonical files by construction.

## Compatibility policy

- The first release is `0.1.0`. Breaking changes are allowed only in a
  noteworthy minor bump, never silently in a patch.
- Every JSONL stream and manifest carries a `schemaVersion`. Readers reject
  unsupported major versions and may accept new optional fields within a
  supported major version.
- Extractors are versioned (`pi-normalize`, `pi-artifacts`, `pi-skills`,
  `pi-events`) and record their version in the `derived*.json` summaries.
  Changing a derived rule or boundary never rewrites the retained raw source
  snapshot.
- Pi adapter coverage is reported, never silently dropped. Unknown entry
  types and unknown tools stay visible in generic streams.
- The Pi session format is owned by Pi. If future Pi versions add entry types,
  message roles, or tool shapes, this adapter records them generically until a
  tool-specific adapter exists.

## Release checks

Run before tagging:

```bash
npm run typecheck
npm test
bash scripts/smoke.sh
node --import tsx scripts/run-benchmark.mjs
```

Additional manual checks for a release:

- [ ] `npm ci` then `npm run typecheck && npm test` from a clean checkout
- [ ] corpus ingestion on quiet sources: no failures, repeat run all `unchanged`
- [ ] `docs/corpus-report.json` regenerated and committed
- [ ] store permissions verified (0700/0600), no world-readable files
- [ ] README workflow matches the current command surface
- [ ] `package.json` parses with `JSON.parse` (a trailing comma here breaks the
      whole module graph)
- [ ] golden fixture output matches `docs/events.md` and `docs/cookbook.md`
