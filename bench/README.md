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

[`tasks/agent-value-v4.json`](tasks/agent-value-v4.json) is the current,
diagnostic multi-hop suite. It keeps the same revision-pinned five fixtures but
replaces three one-hop questions with multi-hop navigation tasks. Its runner is
intentionally separate from v2 so historical evidence cannot be rewritten.
The published [v4 report](results/2026-07-31-agent-value-v4.md) and
[raw rows](results/2026-07-31-agent-value-v4.json) record observed BB
event-timeline intervals alongside correctness and discovery routing; these
intervals are not CPU profiles, hidden-reasoning measurements, or causal
latency claims.

## Controlled variables

Use the fixture commits and exact prompts in the selected task contract, the
same BB host/provider/model/reasoning level, the same permission mode, and an
unmanaged workspace pointing at the same checkout. Reset only the Code
Intelligence installation state between arms, start every thread fresh, and do
not tell the agent to prefer a particular tool.

## Arms

1. **Baseline**: no Code Intelligence plugin is installed.
2. **Code Intelligence**: install the managed Git plugin at the tested commit.

Run every task the number of times declared in its contract. v2 uses five
repetitions per task and arm; v4 currently uses three. Results intentionally
label their sample size and do not generalize beyond their declared tasks.

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

For v4, first set the instruction arm before spawning its threads. Keep the
plugin revision, provider, model, fixture checkout, and permission mode fixed;
only then run the corresponding arm. The `--instruction-style` argument labels
the raw rows — it does not mutate plugin configuration itself.

```bash
# Run this in the enabled arm before spawning its fresh threads.
bb code-intelligence instruction playbook

node bench/run-agent-value-v4.mjs \
  --project <fixture-project-id> \
  --arm plugin_playbook \
  --instruction-style playbook \
  --engine-label remote-host-snapshot \
  --out /tmp/agent-value-v4.json
```

Repeat with `short` and arm name `plugin_short`. For the baseline, uninstall or
disable the plugin, use arm name `baseline_without_plugin`, and omit the
instruction-style label. The runner fetches every event-log page before
selecting the final completed turn, so the diagnostic result does not depend on
the old 500-event log ceiling.

## Metrics

The runner records answer correctness, completed native Code Intelligence tool
calls, shell-search commands, total discovery operations, and end-to-end turn
duration. Completed tool events, rather than plan text, are the source of
truth for tool use.

The v4 runner additionally records paired `item/started` → `item/completed`
event intervals for native Code Intelligence calls, shell-search commands, and
reasoning items. It merges overlaps before calculating the classified portion
of a turn and retains malformed-lifecycle diagnostics. If a completed turn,
pair, type, or timestamp is ambiguous, every v4 duration field is `null` rather
than guessed; call counts and diagnostics remain available for inspection.

## Interpretation

For the known-symbol task, a useful result is an exact native lookup with a
correct concise answer. For the exploratory task, a useful result is a bounded
exploration tool followed by grounded context. Fewer shell searches are a
signal of routing adoption, not a quality result by themselves: the answer
must still satisfy the exact expected-file and required-term checks.

Published data lives in `bench/results/`. It includes only task ids, counts,
durations, answer checks, and completed tool names; it excludes agent hidden
reasoning, prompt history, source snippets, and local filesystem paths.
