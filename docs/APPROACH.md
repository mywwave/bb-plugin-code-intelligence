# Approach and evidence

Code Intelligence is built around a simple rule: choose the smallest tool that
can provide trustworthy evidence for the question — then stop. This keeps
code-navigation output compact for agents while preserving an explicit path to
deeper context when the lean surface is widened.

## Retrieval ladder

1. **Context already present** — if the prompt already has enough source or
   relation evidence, answer with zero discovery calls.
2. **Unknown location / exploratory how-where** — one `codebase_query` explore
   call is Read-equivalent: exact hits plus ranked symbol snippets, call edges,
   blast radius, and dynamic boundaries. Answer from that payload.
3. **Known text or identifier (location only)** — `instant_grep` returns exact
   literal or regex hits when no structural context is needed.
4. **Known direct relationship** — `codebase_query` with `mode: "trace"` joins
   one exact identifier search to the index's direct callers/callees and type
   relations in one agent call. Empty results remain inconclusive around
   dynamic wiring.
5. **Known target, deeper question (full surface)** — `symbol_lookup` and
   `code_graph_context` resolve definitions, static callers, tests, and the
   graph's completeness limits when lean tools are insufficient.
6. **Implementation change** — `prechange_impact` runs before an edit and
   `verify_change` records scoped checks after it.

The default agent tool surface is **lean** (`codebase_query`, `instant_grep`,
`prechange_impact`, `verify_change`). Set `toolSurface: "full"` when structural
extras are required. Discovery is capped at two native discovery calls per
question.

The route is deliberately not a replacement for the terminal. An agent can
still use a shell where appropriate; the plugin makes the common code-reading
path structured, host-aware, and measurable.

## Design hypotheses

| Hypothesis                                                                                  | Design response                                                                                                                                                                  | Why it matters                                                                                                                      |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Agents frequently know a concrete name, string, import, or regex before they know the file. | Make exact search a first-class native tool.                                                                                                                                     | Avoids broad file scans and gives citable lines immediately.                                                                        |
| Exploratory questions need Read-equivalent evidence in one turn, not a search loop.         | `codebase_query` explore returns snippets, edges, blast radius, and stop-`next`.                                                                                                 | Removes multi-hop follow-ups that inflate wall-clock.                                                                               |
| A named-function delegation question normally causes two sequential calls.                  | Trace one exact anchor and direct indexed edges in `codebase_query` mode `trace`.                                                                                                | Keeps direct relation answers to one native call without implying graph completeness.                                               |
| Extra registered tools invite extra round-trips even when unused.                           | Default `toolSurface: lean`; advertise the full set only when opted in.                                                                                                          | Reduces tool-choice churn on navigation turns.                                                                                      |
| Prompt-embedded context still triggers redundant discovery.                                 | Playbook skip-if-context + discovery budget ≤2.                                                                                                                                  | Stops wasteful native/shell searches when the answer is already present.                                                            |
| A local server path can refer to the wrong checkout on multi-host BB.                       | Treat the active thread environment as authoritative and use BB host-file APIs for remote workspaces.                                                                            | Prevents silent cross-workspace reads.                                                                                              |
| A host file listing or file read can be incomplete.                                         | Account for every successfully read enumerated path as indexed or policy-excluded, label a truncated listing in every absence-sensitive result, and fail closed on a read error. | Makes remote coverage limits actionable without falling back to a same-named local path or serving a transiently degraded snapshot. |
| Static analysis is useful but incomplete.                                                   | Report graph completeness and dynamic boundaries with structural results.                                                                                                        | A missing edge is not presented as proof of no runtime dependency.                                                                  |
| Agent tool use should be observed, not assumed.                                             | Record per-surface feedback and follow-up search outcomes; measure speed on v4.                                                                                                  | Lets maintainers measure whether routing reduces unnecessary discovery work without claiming a win early.                           |

## Confirmed evidence

The following checks are reproducible in this repository and documented in
[VALIDATION.md](VALIDATION.md):

- the current automated suite (`npm test`) across exact search, retrieval,
  indexing, project-path routing, persistence, impact analysis, language
  profiles, and release metadata;
- strict TypeScript checking and a repeatable release gate;
- a clean isolated BB `0.34.0` path install with a running plugin and
  `bb code-intelligence` command;
- a fresh read-only Codex thread that invoked `instant_grep` through the BB
  host-file snapshot, consumed its exact result, and made no edits;
- a managed `git:` install from this repository's GitHub `stable` branch, using
  the committed prebuilt release artifacts without local plugin dependencies.
- a controlled six-run-per-arm agent-routing pilot whose raw counts and limits
  are published in [the A/B results](../bench/results/2026-07-31-agent-routing-smoke-v1.md).
- [agent-value-v4](../bench/results/2026-07-31-agent-value-v4.md): multi-hop
  correctness preserved with strong routing adoption, but median event timeline
  **+51%** vs baseline — the speed regression this one-shot lean plan targets.
  No post-change speed claim until a fresh v4 (+ context-already-present) run.

## What has not been claimed

This repository does **not** publish a comparative performance win over
ripgrep. For an explicitly supplied server-local root, `instant_grep` uses
ripgrep. The differentiation is the agent-facing contract, host-aware routing,
bounded exploration, conservative structural context, and feedback
instrumentation.

Earlier exploratory development used internal fixtures and routing experiments
to refine the tool split. Those artifacts are intentionally not presented as a
public benchmark because they are not a clean, independently reproducible
evaluation. [BENCHMARK.md](BENCHMARK.md) specifies the public protocol required
before publishing latency or quality comparisons. In particular, v4's longer
enabled-arm timelines reject a speedup claim until remeasured after lean
one-shot explore.
