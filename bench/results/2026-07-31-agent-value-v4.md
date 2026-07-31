# Multi-hop agent-value A/B, v4

## Method

- Five predeclared, read-only multi-hop navigation tasks in five revision-pinned
  public repositories: Go, Rust, C, C++, and Java. The prompts, expected
  paths, and required answer terms are in the [task contract](../tasks/agent-value-v4.json).
- Three fresh hidden BB threads per task per arm: **30 runs total**.
- Both arms used BB `0.34.0`, Codex `gpt-5.6-sol` at low reasoning, full
  permission mode, the same fixture projects, and the same prompts. The
  baseline had no Code Intelligence plugin installed. The enabled arm used the
  unpublished candidate revision `afe40167d1f004f32c0c9043fb7f662be40c50c8`
  with the `playbook` instruction style.
- Correctness is the contract's expected path plus required final-answer terms.
  Counts come from completed BB events. Each result was rechecked after the
  thread completed; all 30 rows have clean lifecycle diagnostics. In this BB
  version `commandExecution` start/completion events collapse to approximately
  0 ms, so shell-search time is not observable in the classified/unaccounted
  split.

## Aggregate result

| Metric | Without plugin | With plugin | Change |
| --- | ---: | ---: | ---: |
| Correct final answers | 15 / 15 | 15 / 15 | preserved |
| Native Code Intelligence calls | 0 | 27 | native evidence used |
| Shell discovery calls | 39 | 3 | **92.3% fewer** |
| Total discovery operations | 39 | 30 | **23.1% fewer** |
| Median observed full-turn event timeline | 18.0 s | 27.1 s | **50.7% higher** |
| Median runner elapsed time | 21.1 s | 31.0 s | **46.8% higher** |

The enabled arm kept all answers correct and changed 27 of its 30 discovery
operations to native Code Intelligence tools. It made 36 fewer shell-search
calls and nine fewer discovery operations in this fixed task set. That is
evidence of routing adoption and more bounded navigation, not evidence that
the agent is faster.

## Per-task detail

| Task / language | Operations baseline → enabled | Median event timeline baseline → enabled |
| --- | ---: | ---: |
| `Decode` delegation / Go | 7 → 3 | 17.9 s → 21.2 s |
| `Error::new` construction / Rust | 5 → 7 | 15.9 s → 35.6 s |
| `cJSON_Parse` delegation / C | 6 → 3 | 17.5 s → 20.8 s |
| locale `fmt::format` chain / C++ | 12 → 7 | 23.9 s → 27.1 s |
| `Gson.fromJson` read chain / Java | 9 → 10 | 24.7 s → 28.5 s |

## Interpretation and limits

This is the first published use of the v4 event-lifecycle collector. Its
observed intervals are **not** CPU profiles, native-tool runtimes,
hidden-reasoning durations, or causal latency evidence. In particular, the
enabled arm's longer observed timelines mean this sample rejects a speedup
claim; the next optimization must address that cost before any performance
promise is made. The raw rows retain the collapsed shell-event values for
auditability, but they must not be used to compare classified or unaccounted
time between arms. The current collector marks a collapsed channel as
unobservable and returns `null` for that channel and the dependent residuals.

The sample has only three repetitions per task and one enabled instruction
style. It is a reproducible diagnostic baseline, not a significance test, a
raw-ripgrep benchmark, or a claim about arbitrary repositories and tasks. The
complete [raw rows](2026-07-31-agent-value-v4.json) retain the per-turn counts,
event-timeline diagnostics, and thread identifiers; they exclude prompts,
source snippets, hidden reasoning, and local filesystem paths. Earlier
[v3](2026-07-31-agent-value-v3.md) and [v2](2026-07-31-agent-value-v2.md)
results remain historical one-hop evidence and must not be pooled with v4.

## Next measurement (post lean one-shot)

Re-run v4 after lean one-shot explore with arms
`baseline_without_plugin` / `plugin_lean_oneshot` (optional `plugin_full`),
plus a **context-already-present** arm. Success criteria are documented in
[BENCHMARK.md](../../docs/BENCHMARK.md): correctness preserved, median event
timeline not worse than baseline, ≥40% turns with ≤1 discovery, and ≥70%
zero-discovery on context-already-present. Do not claim a speedup from this
v4 baseline alone.
