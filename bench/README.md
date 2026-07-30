# Agent-routing A/B smoke benchmark

This benchmark compares agent behavior with Code Intelligence absent and
installed. It is deliberately a small behavioral smoke suite, not a claim of
statistical performance superiority.

## Controlled variables

Use the repository commit and tasks in `tasks.json`, a fresh BB data directory
for each arm, BB `0.34.0`, the same provider/model, full permission mode, and
unmanaged workspace pointing at the same checkout. Start every thread fresh;
do not tell the agent to prefer a particular tool.

## Arms

1. **Baseline**: no Code Intelligence plugin is installed.
2. **Code Intelligence**: install this commit with
   `bb plugin install git:https://github.com/mywwave/bb-plugin-code-intelligence.git@<commit>`.

Run every task at least three times per arm. The pilot results intentionally
label their sample size and do not generalize beyond these tasks.

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
