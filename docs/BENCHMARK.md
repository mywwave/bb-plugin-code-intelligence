# Benchmark protocol

This protocol measures Code Intelligence as an agent-facing discovery tool. It
does not claim to beat ripgrep: ripgrep is the explicit-server-root exact
engine used by `instant_grep`.

## Fixtures

Use public repositories pinned to immutable commit SHAs. Record repository URL,
commit SHA, file count, total bytes, language mix, operating system, Node
version, BB version, ripgrep version, and CPU model. Do not benchmark private
repositories or publish their file paths.

Use two fixture classes:

1. a small deterministic fixture with literals, regex-only matches, ignored
   files, binary files, and pagination boundaries;
2. public production-style repositories spanning the supported languages under
   test. The agent-value-v2 suite uses five: Go, Rust, C, C++, and Java.

## Search measurements

For each fixed query, run one discarded warm-up and then 20 measured runs.
Record elapsed milliseconds for every run, result count, truncation state,
engine, and error text. Report median and p95 latency, not a single best run.

Compare `instant_grep` results against an independently specified expected
file/line set. Report precision, recall, and mismatches separately for literal,
regex, glob-filtered, and paged queries. Treat a truncated result as a distinct
outcome rather than a successful complete result.

## Discovery-quality measurements

For exploratory tasks, define the task question, expected entry files, and
expected symbols before running either method. Compare the first response's
entry-point recall, whether exact evidence is included, number of follow-up
searches, and total tool-output bytes. Keep agent model, prompt, repository
commit, and time budget fixed across arms. The agent-value-v2 contract records
correctness, completed discovery operations, native-plugin calls,
shell-search calls, and wall time from fresh threads. For `codebase_query`,
also retain the returned plugin-only `timingMs` breakdown (`index`, exact
search, graph work, total); it excludes model/provider latency and must not be
combined with full-turn time.

## Speed KPIs (agent-value-v4)

v4 is the primary speed and multi-hop routing protocol. Keep the same BB host,
provider, model, reasoning level, fixture commits, and permission mode as the
published [v4 diagnostic baseline](../bench/results/2026-07-31-agent-value-v4.md)
(BB `0.34`, `gpt-5.6-sol`, reasoning `low`). Do not invent a parallel harness.

| KPI          | How to measure                                                           | Success bar (do not claim until measured)                                           |
| ------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Correctness  | Expected path + required final-answer terms                              | Preserved vs baseline                                                               |
| Round-trips  | Discovery ops; share of turns with ≤1 native discovery call              | ≥40% of navigation turns ≤1 discovery                                               |
| Wall-clock   | Median `item/started` → `item/completed` event timeline + runner elapsed | Not worse than baseline (~18 s median timeline; must-fix the prior +51% regression) |
| No-redundant | New **context-already-present** arm (below)                              | ≥70% of those turns with 0 discovery calls                                          |

### Arms

1. **baseline** — no Code Intelligence plugin installed.
2. **enabled-lean-oneshot** — plugin at the candidate revision; `toolSurface lean`
   (default), playbook instructions, one-shot explore payload.
3. **enabled-full** (optional) — same revision with `toolSurface full`.

Set the lean surface before enabled-lean threads:

```bash
bb code-intelligence instruction playbook
bb code-intelligence tool-surface lean
```

### Context-already-present arm

Add a small diagnostic set (may reuse v4 fixtures) where the prompt already
includes a sufficient source snippet or relation evidence to answer. Expected
behavior: **0** `codebase_query` / `instant_grep` / shell discovery calls; the
agent answers from the provided context. Record discovery counts the same way
as v4. This arm validates the skip-if-context playbook rule; it is not a
latency claim by itself.

Event-timeline caveats from v4 still apply: intervals are BB event
observations, not CPU profiles or causal proof that a specific tool caused
delay. A malformed lifecycle invalidates duration fields for that run.

## Reporting

Publish raw machine-readable data, the runner command, and a short narrative
of failures. Separate local-server-root and remote-host-snapshot results. Do
not merge them into a single speed number because they have different I/O
paths.

## Published evidence

The first small agent-routing pilot is published under
[`bench/results/`](../bench/results/). The current cross-language suite is
defined in [`bench/tasks/agent-value-v2.json`](../bench/tasks/agent-value-v2.json)
and publishes its [v3 raw result rows and aggregate report](../bench/results/2026-07-31-agent-value-v3.md)
under the same results directory. Neither is a statistically general performance
claim.

The separate [`agent-value-v4` contract](../bench/tasks/agent-value-v4.json)
preserves those fixture commits while adding multi-hop navigation prompts and
event-timeline diagnostics. Its `item/started` → `item/completed` intervals are
only an observation of BB event timing. They are not CPU samples, do not expose
hidden reasoning text, and cannot establish that a particular tool caused a
full-turn delay. A missing, duplicate, mismatched, or non-monotonic lifecycle
pair invalidates every duration field for that run rather than producing a
guessed value. A zero-length event interval is also reported as an
unobservable channel: the collector preserves its call count but returns
`null` for that channel and the dependent classified/residual split. Use v4 to
select a single plugin-only optimization after a controlled run; do not
retroactively reinterpret v2/v3 evidence with it. Re-run v4 (plus the
context-already-present arm) after lean one-shot explore changes before any
speed claim.
