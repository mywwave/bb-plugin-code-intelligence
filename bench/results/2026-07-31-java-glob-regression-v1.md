# Java host-snapshot glob regression A/B, v1

## Why this exists

The earlier cross-language A/B exposed a Java-specific failure mode: agents
commonly used the ripgrep-style glob `*.java`, while the BB host-file snapshot
matched it only at repository root. Nested source such as `Gson.java` was
therefore invisible, causing empty native searches and unnecessary fallbacks.

This change makes a glob without `/` apply to every basename, matching
`rg --glob '*.java'` semantics. Trace anchors now also resolve a qualified
method signature to its declaration name and consult the existing symbol index
when the bounded exact-hit page is filled by examples.

## Method

- One predeclared read-only Java task from the shared
  [task contract](../tasks/agent-value-v2.json): locate
  `Gson.fromJson(String, Class)` and its `TypeToken` operation.
- Five new hidden BB threads per arm in the same pinned Gson commit.
- Same BB `0.34.0`, Codex `gpt-5.6-sol` at low reasoning, and full permission
  mode. Baseline had no Code Intelligence plugin; enabled used this change.
- Correctness required both the declared `Gson.java` path and the two required
  terms in the final visible answer. Metrics came from completed BB events.

## Result

| Metric | Baseline without plugin | Plugin enabled |
| --- | ---: | ---: |
| Correct final answers | 5 / 5 | 5 / 5 |
| Shell discovery calls | 8 | 0 |
| Native Code Intelligence calls | 0 | 6 |
| Total discovery operations | 8 | 6 |
| Median full-turn time | 11.7 s | 9.2 s |

For this one regression task, the enabled arm made 25% fewer discovery
operations and had a 21% lower median full-turn time while preserving answer
correctness. The raw events are in the accompanying
[machine-readable rows](2026-07-31-java-glob-regression-v1.json).

## Limits

This is a targeted five-repetition regression check, not a replacement for the
cross-language suite, a raw search-engine benchmark, or a statistical claim
about all code-navigation tasks. Model tool choices and provider latency remain
sources of variation. The broader
[cross-language A/B](2026-07-31-agent-value-v2.md) remains the correct record
for the earlier implementation and explicitly did not show an aggregate speed
win.
