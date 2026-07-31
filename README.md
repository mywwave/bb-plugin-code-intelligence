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

The current [cross-language A/B](bench/results/2026-07-31-agent-value-v2.md)
ran 50 fresh, read-only BB threads: five predeclared navigation questions in
five pinned public repositories (Go, Rust, C, C++, Java), five repetitions per
arm. The provider/model, permission mode, BB version, and fixture commit were
kept fixed.

| Measured result | Without plugin | With plugin |
| --- | ---: | ---: |
| Correct final answers | `25 / 25` | `25 / 25` |
| Native Code Intelligence calls | `0` | `61` |
| Shell discovery calls | `42` | `10` |
| Total discovery operations | `42` | `71` |
| Median full-turn time | `14.0 s` | `16.6 s` |

So the demonstrated value is **structured native navigation without losing
correctness**: the enabled runs replaced 76% of observed shell-search calls
with Code Intelligence tools. It is not a claim that every task becomes faster
or uses fewer operations — this particular short-task sample did not. Read the
[method and per-language results](bench/results/2026-07-31-agent-value-v2.md),
[task contract](bench/tasks/agent-value-v2.json), and
[raw rows](bench/results/2026-07-31-agent-value-v2.json) before drawing a
broader conclusion. The earlier TypeScript
[routing pilot](bench/results/2026-07-31-agent-routing-smoke-v1.md) remains as
historical evidence.

Run `npm test` for the current automated-suite total. A fresh managed Git
installation of the current `0.1.0` stable release on BB `0.34.0` indexed this repository into `227` symbols and
`2,296` edges with a reported completeness lower bound of `69.6%`; see the
full [validation record](docs/VALIDATION.md) and [approach](docs/APPROACH.md).

## Limits and project status

Static analysis cannot prove dynamic wiring: reflection, generated code,
runtime dispatch, and unparsed languages remain explicit blind spots. The
plugin does not intercept or prohibit arbitrary terminal searches.

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
