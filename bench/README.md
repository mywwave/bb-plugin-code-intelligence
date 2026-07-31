# Agent-routing A/B benchmarks

These benchmarks compare agent behavior with Code Intelligence absent and
enabled. They measure code-navigation behavior, not raw search-engine speed or
general developer productivity.

The first TypeScript smoke pilot remains published for historical comparison.
The current cross-language evidence suite is
[`tasks/agent-value-v2.json`](tasks/agent-value-v2.json): five pinned public
repositories (Go, Rust, C, C++, and Java), five read-only navigation questions,
and five fresh repetitions in each arm. Its report and raw result data are
[published](results/2026-07-31-agent-value-v3.md) beside the task contract.
The earlier [v2 result](results/2026-07-31-agent-value-v2.md) remains a
historical pre-fix measurement.
The Java host-snapshot glob regression discovered by that suite has its own
[targeted A/B record](results/2026-07-31-java-glob-regression-v1.md); it does
not replace the cross-language result.

## Controlled variables

Use the fixture commits and exact prompts in the selected task contract, the
same BB host/provider/model/reasoning level, the same permission mode, and an
unmanaged workspace pointing at the same checkout. Reset only the Code
Intelligence installation state between arms, start every thread fresh, and do
not tell the agent to prefer a particular tool.

## Arms

1. **Baseline**: no Code Intelligence plugin is installed.
2. **Code Intelligence**: install the managed Git plugin at the tested commit.

Run every task the number of times declared in its contract. The current suite
uses five repetitions per task and arm. Results intentionally label their sample
size and do not generalize beyond their declared tasks.

The included runner records a single task against its own BB project root;
repeat it for each fixture and arm, using the exact project, arm, and output
file for that collection:

```bash
node bench/run-agent-value-v2.mjs \
  --project <fixture-project-id> \
  --task go-decode-delegation \
  --arm baseline_without_plugin \
  --out /tmp/agent-value-v2.json
```

## Metrics

The runner records answer correctness, completed native Code Intelligence tool
calls, shell-search commands, total discovery operations, and end-to-end turn
duration. Completed tool events, rather than plan text, are the source of
truth for tool use.

## Interpretation

For the known-symbol task, a useful result is an exact native lookup with a
correct concise answer. For the exploratory task, a useful result is a bounded
exploration tool followed by grounded context. Fewer shell searches are a
signal of routing adoption, not a quality result by themselves: the answer
must still satisfy the exact expected-file and required-term checks.

Published data lives in `bench/results/`. It includes only task ids, counts,
durations, answer checks, and completed tool names; it excludes agent hidden
reasoning, prompt history, source snippets, and local filesystem paths.
