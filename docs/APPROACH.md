# Approach and evidence

Code Intelligence is built around a simple rule: choose the smallest tool that
can provide trustworthy evidence for the question. This keeps code-navigation
output compact for agents while preserving an explicit path to deeper context.

## Retrieval ladder

1. **Known text or identifier** — `instant_grep` returns exact literal or
   regex hits, with glob filtering, context, and paging. This is the intended
   route for patterns such as `PaymentFailedError` or `import.*Service`.
2. **Unknown location** — `codebase_query` starts bounded exploration and
   returns exact evidence plus ranked entry points instead of making the agent
   infer a broad shell command.
3. **Known target, deeper question** — `symbol_lookup` and
   `code_graph_context` resolve definitions, static callers, tests, and the
   graph's completeness limits.
4. **Implementation change** — `prechange_impact` runs before an edit and
   `verify_change` records scoped checks after it.

The route is deliberately not a replacement for the terminal. An agent can
still use a shell where appropriate; the plugin makes the common code-reading
path structured, host-aware, and measurable.

## Design hypotheses

| Hypothesis | Design response | Why it matters |
| --- | --- | --- |
| Agents frequently know a concrete name, string, import, or regex before they know the file. | Make exact search a first-class native tool. | Avoids broad file scans and gives citable lines immediately. |
| Exploratory questions need entry points, not an unbounded semantic answer. | Combine exact-hit evidence with bounded graph ranking in `codebase_query`. | Keeps exploration grounded in repository files. |
| A local server path can refer to the wrong checkout on multi-host BB. | Treat the active thread environment as authoritative and use BB host-file APIs for remote workspaces. | Prevents silent cross-workspace reads. |
| Static analysis is useful but incomplete. | Report graph completeness and dynamic boundaries with structural results. | A missing edge is not presented as proof of no runtime dependency. |
| Agent tool use should be observed, not assumed. | Record per-surface feedback and follow-up search outcomes. | Lets maintainers measure whether routing reduces unnecessary discovery work. |
| Native tool labels should remain readable in a live thread. | Keep an optional, scoped timeline presentation script. | Improves observability without altering tool arguments or results. |

## Confirmed evidence

The following checks are reproducible in this repository and documented in
[VALIDATION.md](VALIDATION.md):

- 164 automated tests across exact search, retrieval, indexing, project-path
  routing, persistence, impact analysis, presentation, and release metadata;
- strict TypeScript checking and a repeatable release gate;
- a clean isolated BB `0.34.0` path install with a running plugin, compatible
  frontend bundle, and `bb code-intelligence` command;
- a fresh read-only Codex thread that invoked `instant_grep` through the BB
  host-file snapshot, consumed its exact result, and made no edits;
- a managed `git:` install from this repository's GitHub `main` branch, using
  the committed prebuilt release artifacts without local plugin dependencies.
- a controlled six-run-per-arm agent-routing pilot whose raw counts and limits
  are published in [the A/B results](../bench/results/2026-07-31-agent-routing-smoke-v1.md).

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
before publishing latency or quality comparisons.
