# Code Intelligence

Code Intelligence is a BB plugin for exact code discovery and conservative
static context. Its product name, plugin id, and CLI command are deliberately
consistent: **Code Intelligence** / `code-intelligence` /
`bb code-intelligence`.

- `instant_grep` — exact literal/regex search with glob, context and paging.
- `codebase_query` — bounded natural-language exploration backed by exact hits and graph ranking.
- `code_graph_context`, `symbol_lookup`, `prechange_impact` and `verify_change` — conservative structural context and change gates.
- `repository_context` — allowlisted repository orientation and declared checks.

The current thread environment is the source of truth and is read through the
BB host-file API, never through a same-named path on the server. An explicitly
supplied server-local root uses ripgrep. Dynamic wiring, reflection, generated
code and unparsed languages remain explicit static-analysis blind spots.

`Instant Grep` is the exact-search tool inside Code Intelligence; it is
not a separate plugin or product. `code_graph_context` is a stable technical
tool identifier, not the plugin's display name.

## Tool routing

Use `instant_grep` for a known identifier, literal, import, or regex. Use
`codebase_query` when the question is exploratory and no exact target is known
yet. Once a target is found, use `symbol_lookup` or `code_graph_context` for
definitions, callers, tests, and stated analysis limits. Before and after a
code change, use `prechange_impact` and `verify_change`.

The plugin cannot intercept or prohibit arbitrary shell searches. It does not
claim to be faster than ripgrep: an explicitly supplied server-local root uses
ripgrep as its exact-search engine.

## Development

```bash
npm ci
npm run verify:release
```

`dist/` is the distributable artifact. The bundled `types/` declarations keep
the plugin typecheckable without a BB checkout. `app.tsx` contains only the
timeline-label presentation script; it does not add a panel or settings UI.

## Install

```bash
bb plugin install .
```

For a development install that predates this rename, remove the old
`codegraph` plugin before installing this build. Plugin ids own their state, so
the two versions must not be loaded together: both register the same native
tools.

## Prototype status

This is an independent prototype, not an official BB plugin. It is intended
for local evaluation and maintainer discussion. See [the maintainer proposal](docs/MAINTAINER_PROPOSAL.md)
for the future official-plugin integration boundary and [the approach and
evidence](docs/APPROACH.md) for the design rationale.
