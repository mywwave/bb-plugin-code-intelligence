# Code Intelligence for BB

Code Intelligence gives BB agents a disciplined code-navigation path: exact
search first, then bounded exploration and conservative static context when it
is actually needed. It is a third-party prototype — not an official BB plugin.

## Install in under a minute

Requires BB `0.34+`. Third-party plugins are full-trust server code: install
only a source you trust.

```bash
# Enable the BB Plugins experiment once.
bb settings experiment plugins true

# Install the published, prebuilt release artifact.
bb plugin install --yes git:https://github.com/mywwave/bb-plugin-code-intelligence.git@main

# Confirm that it loaded.
bb plugin list
```

`code-intelligence@0.1.0` should show as `running`. No `npm install` is needed
on the BB host: the Git artifact includes its server bundle, frontend bundle,
and parser runtime.

To verify graph indexing explicitly in a local checkout:

```bash
bb code-intelligence index /absolute/path/to/repository
bb code-intelligence status
```

For updates, run `bb plugin update code-intelligence`. For local development,
use `bb plugin install .` after `npm ci`.

## What the agent gets

| Question shape | Native tool | Result |
| --- | --- | --- |
| Known identifier, string, import, or regex | `instant_grep` | Exact file/line hits, glob filtering, context, and paging. |
| “Where/how is this handled?” with no exact target | `codebase_query` | Bounded exploration: exact evidence plus ranked entry files. |
| Known symbol/file, need callers or tests | `symbol_lookup`, `code_graph_context` | Definitions, static relationships, tests, and stated graph limits. |
| Before or after an implementation edit | `prechange_impact`, `verify_change` | Direct impact and declared verification checks. |

`repository_context` provides allowlisted repository orientation and declared
checks. The current BB thread environment is authoritative: remote workspaces
are read through BB's host-file API rather than a same-named server path.

`Instant Grep` is the exact-search tool inside Code Intelligence, not a
separate product. For an explicitly supplied server-local root, it uses
ripgrep as the exact-search engine.

## Evidence, not promises

The public [agent-routing A/B pilot](bench/results/2026-07-31-agent-routing-smoke-v1.md)
compares a clean BB instance against the same instance with this plugin. Both
arms used read-only tasks and the same provider/model/repository commit.

| Task | Correct answers, baseline → enabled | Shell discovery searches | Other observed result |
| --- | --- | --- | --- |
| Known symbol | `3/3 → 3/3` | `3 → 0` | Native `instant_grep`: `0 → 3`. |
| Exploratory routing | `3/3 → 3/3` | `21 → 5` | Native `instant_grep`: `0 → 11`; total operations: `45 → 35`. |

The exploratory-task median wall time was `35.2 s → 31.0 s`. Raw counts,
prompts, environment, and per-run timings are in the linked report and
[machine-readable data](bench/results/2026-07-31-agent-routing-smoke-v1.json).

This is evidence that the plugin changed observed agent routing without losing
correctness in those tasks. It is **not** a general latency, cost, or quality
claim: the pilot has three runs per task, one provider/model, and one public
TypeScript repository. It does not claim to beat ripgrep.

Release checks currently cover 165 automated tests. A fresh managed Git
installation on BB `0.34.0` indexed this repository into `232` symbols and
`2,303` edges with a reported completeness lower bound of `69.9%`; see the
full [validation record](docs/VALIDATION.md) and [approach](docs/APPROACH.md).

## Limits and project status

Static analysis cannot prove dynamic wiring: reflection, generated code,
runtime dispatch, and unparsed languages remain explicit blind spots. The
plugin does not intercept or prohibit arbitrary terminal searches.

This repository is prepared for maintainer review, but no upstream BB issue or
pull request has been opened yet. The proposed integration boundary is in the
[maintainer proposal](docs/MAINTAINER_PROPOSAL.md).

## Development

```bash
npm ci
npm run verify:release
```

`dist/` is the managed-install artifact. `app.tsx` is limited to the optional
timeline-label presentation script; it does not add a panel or settings UI.
