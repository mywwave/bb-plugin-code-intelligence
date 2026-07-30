# Agent-routing A/B smoke results

Raw counts: [2026-07-31-agent-routing-smoke-v1.json](2026-07-31-agent-routing-smoke-v1.json)

## Setup

The tasks were defined before execution in `../tasks.json`. Both arms used
fresh BB `0.34.0` instances, the same public repository commit, Codex
`gpt-5.5`, full permission mode, an unmanaged copy of the same workspace, and
read-only prompts. The baseline had no Code Intelligence plugin. The enabled
arm installed the plugin from its managed GitHub source. Each task ran three
times per arm.

Correctness means that the final answer named the expected implementation file
and included the required terms specified in the task. Shell-search counts come
from completed command events containing `rg`, `grep`, `find`, `fd`, `ag`, or
`ack`; native counts come from completed native tool events.

## Results

| Task | Correct, baseline → enabled | Native calls, baseline → enabled | Shell searches, baseline → enabled | Operations, baseline → enabled | Median duration, baseline → enabled |
| --- | --- | --- | --- | --- | --- |
| Known symbol | 3/3 → 3/3 | 0 → 3 `instant_grep` | 3 → 0 | 10 → 8 | 14.9s → 12.9s |
| Exploratory routing | 3/3 → 3/3 | 0 → 11 `instant_grep` | 21 → 5 | 45 → 35 | 35.2s → 31.0s |

## What this supports

For these two tasks, Code Intelligence preserved answer correctness while
routing the agent away from most shell discovery. The exact known-symbol task
used `instant_grep` on every enabled run and no shell search. The exploratory
task still used some shell searches, but shell discovery dropped from 21 to 5
completed search commands across the three runs while the agent used 11 native
exact-search calls.

The median turn durations also fell in this pilot, but latency is not the
primary result: model deliberation and provider scheduling dominate a small
sample. The more directly observed behavior is the completed tool-event mix.

## Limits

This is a pilot with three runs per task, one provider/model, and one public
TypeScript repository. It is not statistically significant and does not prove
general latency, accuracy, or cost improvements. It does not compare the
underlying exact-search engine with ripgrep; local `instant_grep` intentionally
uses ripgrep. Use the protocol in [../BENCHMARK.md](../BENCHMARK.md) before
making broader performance claims.
