# divya-drushti (`dvdst`)

`dvdst` turns coding-agent sessions into structured development evidence.

The first adapter ingests Pi sessions from Omakase. The first release exposes messages, tool activity, file activity, commands, tests, skill invocations, attributed skill spans, and provenance as JSONL.

## Quick start

```bash
cd ~/Projects/dvdst
npm install
npm test
```

For concrete commands and real Omakase examples, read [`docs/usage.md`](docs/usage.md).

## Project documents

- [`docs/usage.md`](docs/usage.md) - how to run the probe, handoff, devlog mapper, and benchmark.
- [`docs/cp0-benchmark.md`](docs/cp0-benchmark.md) - product-proof results and three-case benchmark.
- [`docs/benchmark-report.md`](docs/benchmark-report.md) - latest benchmark output as a table.
- [`docs/project-plan.md`](docs/project-plan.md) - scope, checkpoints, and completion criteria.
- [`docs/pi-session-source.md`](docs/pi-session-source.md) - findings from the Pi source format and the Omakase session corpus.
- [`docs/evidence-model.md`](docs/evidence-model.md) - the first storage and provenance design.

## Product boundary

Adapters produce evidence. Extractors produce events. CLI tools expose both. Profiles and recipes consume them.

The canonical evidence store uses files and JSONL. An index can improve queries later, but it does not replace canonical files.
