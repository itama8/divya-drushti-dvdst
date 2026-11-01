# Discover commands as data

`capabilities` exposes the built-in CLI surface for models and scripts without
loading project extractors, parsing transcripts, or creating an evidence store.

```bash
node bin/dvdst.mjs capabilities
node bin/dvdst.mjs capabilities --group exploration
node bin/dvdst.mjs capabilities search
node bin/dvdst.mjs capabilities message --format text
node bin/dvdst.mjs schema capabilities --format json
```

The default format is JSON. No target returns compact entries for all built-ins;
`--group` filters them to `exploration`, `inspection`, `storage`, `live`,
`staging`, or `utility`. A command target returns one detailed entry. A target
and group cannot be combined. `--format text` supports human inspection.
Unknown names/groups/formats fail with nonzero exit and no success output.

## Compact entries

The root is `{schemaVersion: 1, commands: [...], notes: [...]}`. Each compact
entry includes:

- `name`, `summary`, and `group` for choosing an operation.
- `sessionSources`: transcript sources this command can consume. An empty
  array means it is not a transcript reader; live producer namespaces are a
  separate interface. `sessions` is Pi filename discovery, and `session-stage`
  selects Claude/Codex. Cross-agent analysis does not imply a live adapter.
- `effects`: conditional persistent writes or caller-code execution, with
  `kind` and `when`. Empty means no listed material effect, not a sandbox.
- `hasOutputSchema`: whether a shared field schema is currently available.

Effects distinguish cache writes, store writes, explicit file output, Git
index publication, store deletion, and extractor module execution. For example,
`calls` normally caches rows; `search` does not; `skills` in store mode may
create missing derived records; `stage` can publish to the index and never
commits. Existing staging protections and explicit mutation flags are unchanged.

## Detailed entries

```bash
node bin/dvdst.mjs capabilities calls
node bin/dvdst.mjs capabilities stage
```

Details add `positionals`, `inputSchema`, `options`, `output`, `constraints`,
`limitations`, and `examples` (argument arrays). Placeholder projects in examples
must be replaced; fixture examples run from the DVDST checkout.

`inputSchema` is a JSON Schema for typed normal-invocation data:

```json
{
  "positionals": ["/path/to/session.jsonl"],
  "options": {"query": "parser failed", "in": "results", "limit": 5, "page": true}
}
```

Option keys omit the leading `--`. Numbers are typed integers here; format
them as argument strings when invoking the CLI. Boolean true emits the flag;
false omits it. `x-cli-short` identifies a short alias. Integer bounds, enum
choices, and effective defaults describe supported values. Environment-dependent
or dynamic defaults use `x-default-description` instead of a fixed schema
default. `--help` is a separate invocation mode.

`options` contains the same executable parser definitions used by the CLI,
with descriptions and value metadata. A parser `default` differs from an
`effectiveDefault` applied later by command logic. The shared adapter passes
only Node's parser fields to `parseArgs`; metadata is not a Node parser API.

The input schema describes value shapes, not every cross-field selection mode.
Read `constraints` too: exact readers accept a reference OR a session/selector,
and stored selection differs from transcript discovery. CLI handlers continue
to enforce their own mode/semantic checks. Capability discovery is not a generic
execution endpoint or a replacement for validation.

`output` gives supported formats, default format, shape description, and shared
field `schema`. For built-in exploration outputs, that schema is the same
object returned by `schema <name>`. For `files`, `commands`, and `skills`, the shared schema applies to the opt-in
`--contract exploration`; existing legacy output is still the default. Their
constraints explain the modes, conditional defaults, and stored selection. See
[inspection queries](inspection-queries.md). Other outputs without a declared field
contract explicitly return `schema: null`; a shape description does not define
their JSON fields. Do not invent fields for those outputs.

## Scope and extensions

The dispatcher/help and this catalog use one command registry. CLI parsers use
one set of executable option definitions; aliases and parser defaults are not
copied into a separate hand-maintained catalog. Shared output schemas are also
used by `schema`. Regression coverage checks every advertised option against
its command's parser configuration.

Catalog lookup never discovers/imports `.dvdst/extractors`, including when an
extractor shares a built-in name. Use `rows <name|file>` for caller-selected
extractors. `schema` without a target, or with an extractor target, can run
module initialization while obtaining its declared schema; this is recorded
as an execution effect. A known built-in schema target does not load extractors.

Core commands make no model calls or network requests. Extractor code runs with
caller permissions and may do either. The catalog reports command contracts,
not proof of source completeness, successful validation, or product acceptance.
Conversation `--page` provides source completeness for an actual query.

The library exports `getCapabilities(command?, group?)` from `dvdst`. Returned
descriptors are copies: modifying them does not alter live parser defaults.
