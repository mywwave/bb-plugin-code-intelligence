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

# Install the published, prebuilt stable channel.
bb plugin install --yes git:https://github.com/mywwave/bb-plugin-code-intelligence.git@stable

# Confirm that it loaded.
bb plugin list
```

`code-intelligence@0.1.0` should show as `running`. No `npm install` is needed
on the BB host: the Git artifact includes its server bundle and parser runtime.

### Install from the BB interface

Open **Plugins** → **Add plugin**, then paste this exact value into the
installation field and select **Install plugin**:

```text
git:https://github.com/mywwave/bb-plugin-code-intelligence.git@stable
```

To verify graph indexing explicitly in a local checkout:

```bash
bb code-intelligence index /absolute/path/to/repository
bb code-intelligence status
```

BB never applies a third-party plugin update on its own. To check and apply a
compatible stable update, use **Tools → Plugins → Code Intelligence → Check
now → Update**, or run `bb plugin outdated` followed by
`bb plugin update code-intelligence`. For local development, use
`bb plugin install .` after `npm ci`; contributors who deliberately want
unreleased commits may track the repository's `main` branch instead.

## What the agent gets

| Question shape | Native tool | Result |
| --- | --- | --- |
| Enough source already in the prompt | *(none)* | Answer; skip discovery. |
| Known identifier, string, import, or regex (location only) | `instant_grep` | Exact file/line hits, glob filtering, context, and paging. |
| “Where/how is this handled?” with no exact target | `codebase_query` | Read-equivalent one-shot: exact hits, snippets, edges, blast radius. |
| Known identifier, direct caller/callee/delegation | `codebase_query` with `mode: "trace"` | Exact source context and direct static relations in one call. |
| Known symbol/file, need deeper callers or tests (full surface) | `symbol_lookup`, `code_graph_context` | Definitions, static relationships, tests, and stated graph limits. |
| Before or after an implementation edit | `prechange_impact`, `verify_change` | Direct impact and declared verification checks. |

Default agent surface is **lean** (`codebase_query`, `instant_grep`,
`prechange_impact`, `verify_change`). Use `bb code-intelligence tool-surface full`
when structural extras are needed.

`repository_context` provides allowlisted repository orientation and declared
checks. The current BB thread environment is authoritative: remote workspaces
are read through BB's host-file API rather than a same-named server path.

`Instant Grep` is the exact-search tool inside Code Intelligence, not a
separate product. For an explicitly supplied server-local root, it uses
ripgrep as the exact-search engine.

## Language coverage

The structural graph is deliberately syntax-first: it records declarations,
call sites, and syntactic imports, then resolves only local targets that were
actually indexed. It supports:

| Source language | Extensions | Grammar asset | Conservative resolution boundary |
| --- | --- | --- | --- |
| TypeScript / TSX | `.ts`, `.mts`, `.cts`, `.tsx` | TypeScript / TSX | Relative modules only. |
| JavaScript | `.js`, `.mjs`, `.cjs`, `.jsx` | JavaScript | Relative modules only. |
| Python | `.py`, `.pyi` | Python | Relative modules only. |
| Go | `.go` | Go | Imports are recorded; module/package roots are not guessed. |
| Rust | `.rs` | Rust | Explicit local `mod` paths may resolve to indexed `.rs` files; crate roots are not guessed. |
| C | `.c`, `.h` | bundled C++ grammar | A C-family baseline; quoted relative headers may resolve to indexed files. |
| C++ | `.cc`, `.cp`, `.cpp`, `.cxx`, `.hpp`, `.hh`, `.hxx` | C++ | Quoted relative headers may resolve to indexed files. |
| Java | `.java` | Java | Imports are recorded; classpaths and packages are not guessed. |

The published WASM package has no separate C grammar. C therefore explicitly
uses its version-matched C++ grammar asset, validated against the C-family
fixture in the automated suite. This is a baseline parser choice, not a claim
that C preprocessor semantics or a compiler's type system are modelled.

## What changes for a developer

| Without Code Intelligence | With Code Intelligence |
| --- | --- |
| The agent composes its own `rg`/`find`/file-reading commands and interprets raw output. | Known names and patterns have bounded exact search; vague questions have ranked entry points; callers, tests, impact, and verification have dedicated context tools. |
| Useful code evidence exists only in the terminal transcript the agent happened to build. | Tool results carry explicit files/lines, paging, and conservative static-analysis limits, so the next step has a narrower, citable basis. |
| Each agent and task must rediscover a search routine. | BB supplies one host-aware navigation path across the supported languages while retaining shell fallback for unusual cases. |

## Evidence, not promises

The latest [cross-language multi-hop A/B](bench/results/2026-07-31-agent-value-v4.md)
ran 30 fresh, read-only BB threads: five predeclared navigation questions in
five pinned public repositories (Go, Rust, C, C++, Java), three repetitions per
arm. The provider/model, permission mode, BB version, fixture commit, and
prompt were kept fixed. The enabled arm used the unpublished candidate revision
documented in the report; it is not a claim about an already released package.

| Measured result | Without plugin | With plugin | Change |
| --- | ---: | ---: | ---: |
| Correct final answers | `15 / 15` | `15 / 15` | preserved |
| Native Code Intelligence calls | `0` | `27` | replaces shell discovery |
| Shell discovery calls | `39` | `3` | **92.3% fewer** |
| Total discovery operations | `39` | `30` | **23.1% fewer** |
| Median observed full-turn event timeline | `18.0 s` | `27.1 s` | **50.7% higher** |

So the demonstrated value is **structured native navigation without losing
correctness**: on this fixed multi-hop task set, the enabled arm made 36 fewer
shell-search calls and 9 fewer discovery operations. It was also slower in the
observed event timeline, so this result is evidence for routing quality, not a
speed claim. Read the [method and per-language results](bench/results/2026-07-31-agent-value-v4.md),
[task contract](bench/tasks/agent-value-v4.json), and
[raw rows](bench/results/2026-07-31-agent-value-v4.json) before drawing a
broader conclusion. Individual task samples still vary, and event intervals
are not CPU or causal-latency measurements. The prior cross-language
[v3 report](bench/results/2026-07-31-agent-value-v3.md), [v2 report](bench/results/2026-07-31-agent-value-v2.md),
and earlier TypeScript [routing pilot](bench/results/2026-07-31-agent-routing-smoke-v1.md)
remain historical evidence.

The earlier v2 A/B found a concrete Java host-snapshot incompatibility: a
familiar `*.java` glob did not reach nested source directories. The fixed,
targeted [Java regression A/B](bench/results/2026-07-31-java-glob-regression-v1.md)
kept correctness at `5 / 5` while eliminating shell discovery calls
(`8 → 0`, **100% fewer**), reducing total discovery operations (`8 → 6`,
**25% fewer**), and reducing median full-turn time (`11.7 s → 9.2 s`,
**21.5% lower**).

The improvement comes from three concrete behavior fixes: basename globs such
as `*.java` now search recursively like ripgrep; qualified method signatures
are reduced to their declaration anchor for `trace`; and a trace prefers the
indexed declaration when its first exact-hit page contains usage examples.
This remains a one-task regression result, not an aggregate performance claim.

Run `npm test` for the current automated-suite total. A fresh managed Git
installation of the current `0.1.0` stable release on BB `0.34.0` indexed this repository into `227` symbols and
`2,296` edges with a reported completeness lower bound of `69.6%`; see the
full [validation record](docs/VALIDATION.md) and [approach](docs/APPROACH.md).

## Limits and project status

Static analysis cannot prove dynamic wiring: reflection, generated code,
runtime dispatch, and unparsed languages remain explicit blind spots. The
plugin does not intercept or prohibit arbitrary terminal searches.

For a remote BB workspace, `bb code-intelligence status` reports the number of
host paths indexed and every successful-snapshot policy exclusion (`ignored`,
`excluded`, `tooLarge`, or `nonUtf8`). A host-file read failure is fail-closed:
it preserves the last known-good snapshot rather than serving a degraded one.
If the host inventory is truncated, the remaining paths are explicitly unknown
and every agent-facing absence-sensitive result carries that limit; the plugin
never substitutes a same-named server-local checkout.

`trace` reports only direct edges found in the static index. An empty trace is
not proof that a runtime relation does not exist.

The proposed integration boundary is in the
[maintainer proposal](docs/MAINTAINER_PROPOSAL.md).

## Development

```bash
npm ci
npm run check
# Optional: run the same gate before each push.
npm run install-git-hooks
```

`dist/` is the managed-install artifact. The plugin intentionally has no
frontend bundle, panel, or settings UI.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the full local development and
pull-request workflow.
