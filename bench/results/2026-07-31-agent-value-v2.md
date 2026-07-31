# Cross-language agent-value A/B, v2

## Question

Does installing Code Intelligence change how an otherwise identical BB agent
navigates code, without reducing answer correctness? This is an agent-routing
measurement, not a ripgrep-speed or general-productivity benchmark.

## Method

- Five public repositories pinned in the
  [task contract](../tasks/agent-value-v2.json): Go, Rust, C, C++, and Java.
- Five read-only definition-and-delegation questions; the expected path and
  required answer terms were declared before either arm ran.
- Five new hidden BB threads per task per arm: 50 runs total.
- Same BB `0.34.0`, Codex `gpt-5.6-sol` at low reasoning, full permission mode,
  macOS `27.0` on arm64, Node `24.11.1`, and ripgrep `15.1.0`.
- Baseline had no Code Intelligence plugin. Enabled used managed Git `main` at
  `34d4d5688a717743b4ce94c1d450c6661a7ab435`.
- Correctness was evaluated from the final visible answer. Tool use was counted
  from completed BB events, not the agent's stated plan.

## Result

| Metric | Baseline without plugin | Plugin enabled |
| --- | ---: | ---: |
| Correct final answers | 25 / 25 | 25 / 25 |
| Native Code Intelligence calls | 0 | 61 |
| Shell discovery calls | 42 | 10 |
| Total discovery operations | 42 | 71 |
| Median full-turn time | 14.0 s | 16.6 s |

The enabled arm shifted `61 / 71` discovery operations to native tools and
reduced observed shell-search calls by `32` (76%). It still used shell search
10 times: Code Intelligence guides and supplies tools; it does not block a
terminal fallback.

| Task / language | Correct baseline → enabled | Shell calls baseline → enabled | Median turn time baseline → enabled |
| --- | ---: | ---: | ---: |
| `Decode` delegation / Go | 5/5 → 5/5 | 10 → 0 | 14.7 s → 19.6 s |
| `Error` backtrace / Rust | 5/5 → 5/5 | 12 → 2 | 18.2 s → 21.6 s |
| `cJSON_Parse` / C | 5/5 → 5/5 | 8 → 0 | 14.8 s → 14.0 s |
| locale `vformat` / C++ | 5/5 → 5/5 | 7 → 1 | 13.5 s → 13.5 s |
| `Gson.fromJson` / Java | 5/5 → 5/5 | 5 → 7 | 12.7 s → 22.4 s |

## What this proves — and what it does not

For these five real code-navigation questions, the plugin preserved correct
answers while changing the agent's work from ad-hoc shell search toward native
exact-search and code-context tools. That is the practical product value: BB
receives bounded, tool-typed, citable code evidence instead of only a sequence
of shell commands.

This sample does **not** show a latency or operation-count win. On these short
questions, the enabled arm made more discovery calls and had a slower aggregate
median. It therefore must not be used to claim that Code Intelligence is
faster than ripgrep, cheaper, or better for every programming task. It is a
small observational sample, not a significance test. The raw rows and exact
measurement definitions are in the accompanying
[machine-readable data](2026-07-31-agent-value-v2.json).
