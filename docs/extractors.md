# Extractors and the library

dvdst ships four row streams. A project adds its own with an extractor: a
small file that turns one parsed session into rows. dvdst supplies the rest:
session selection, project rules, and output formats.

## Write an extractor

Put a file in `.dvdst/extractors/` of the directory you run dvdst from. Its
name is the command.

```js
// .dvdst/extractors/slow.mjs
export default {
  description: "Tool calls slower than ten seconds.",
  derive: (session) =>
    session.calls
      .filter((call) => call.durationMs > 10000)
      .map(({ session, seq, tool, durationMs, command }) => ({ session, seq, tool, durationMs, command })),
};
```

```bash
dvdst slow latest
dvdst slow --project omakase-v2 --last 50 --format tsv
```

`derive` receives one session and returns its rows. The session has these
fields:

| field | content |
| --- | --- |
| `session`, `path`, `cwd` | session id, session file, and recorded working directory |
| `source` | the agent that wrote the session: `pi` or `claude` |
| `overview` | the session's `overview` row |
| `turns`, `calls`, `context` | the row streams, with the `--full` fields: call arguments and result text, and section text |
| `records` | every entry, with its line and byte range; a Claude Code session is converted to the Pi entry shape |
| `config` | the project rules that classified the commands |

`dvdst schema calls` prints the fields of each row. Use `records` when the rows
lack something. Carry `session` on every row you return, and `line` where you
have it, so a reader can trace a row back to its entry.

An extractor accepts the selection and format options of the built-in streams:
a session spec, `--last`, `--since`, `--root`, `--project`, `--config`, and
`--format`.

### Summarize across sessions

Add `summarize` to reduce the rows of every selected session to the rows to
print. Use it for counts and rankings.

```js
export default {
  description: "Tool use across sessions.",
  derive: (session) => session.calls.map((call) => ({ tool: call.tool })),
  summarize(rows) {
    const counts = new Map();
    for (const row of rows) counts.set(row.tool, (counts.get(row.tool) ?? 0) + 1);
    return [...counts].map(([tool, calls]) => ({ tool, calls })).sort((a, b) => b.calls - a.calls);
  },
};
```

### Declare fields

`fields` is optional. It gives `dvdst schema` its text and TSV its column
order. Without it, TSV columns are the keys of the rows in first-seen order.

```js
fields: [{ name: "tool", type: "string", description: "Tool name." }],
```

### Where dvdst looks

- `dvdst <name>` and `dvdst rows <name>` look in `.dvdst/extractors/` under
  the working directory, then in each directory of `DVDST_EXTRACTORS`, a
  colon-separated list.
- `dvdst rows <file>` runs a file from any path.
- `dvdst schema` lists the extractors it finds, after the built-in streams.

A built-in command wins over an extractor of the same name. Use
`dvdst rows <name>` to run the extractor.

An extractor is code that runs with your permissions. dvdst loads it from
directories you choose and never from the working directory a session
recorded.

A file may be `.mjs`, `.js`, `.ts`, or `.mts`. A TypeScript file can take its
types from dvdst:

```ts
import type { Extractor } from "dvdst";

const extractor: Extractor = { derive: (session) => [session.overview] };
export default extractor;
```

`examples/extractors/` has two complete extractors: `orientation.mjs` reports
what each session read before its first edit, and `failing-commands.mjs` ranks
failing commands across sessions.

## Use the library from a script

When an analysis needs more than rows out, import dvdst and start from parsed
sessions. Run the script with `tsx`.

```ts
// analysis.mts
import { loadSessions } from "dvdst";

let cost = 0;
for await (const session of loadSessions({ project: "omakase-v2", last: 50 })) {
  cost += session.overview.cost as number;
}
console.log(cost);
```

- `loadSession(spec)` loads one session named by a file, an id or id prefix,
  or `latest`.
- `loadSessions(selection)` yields the selected sessions one at a time, oldest
  first. The selection takes `specs`, `last`, `since`, `root`, and `project`.
- `loadSessionFile(path)` loads a file with no lookup.

Each returns the session object an extractor receives. The library also
exports `parseBashEffects`, `classifyCommand`, `resolveSessions`,
`loadProjectConfig`, `readJsonl`, and the `STREAMS` schema table.

The import name `dvdst` resolves inside this repository and in a project that
has linked it with `npm link dvdst`. Elsewhere, import
`/path/to/dvdst/src/index.ts`.
