# Cross-language agent-value A/B, v3

## Method

- Five predeclared read-only navigation tasks in five pinned public repositories:
  Go, Rust, C, C++, and Java. The exact prompts and expected answers are in the
  [task contract](../tasks/agent-value-v2.json).
- Five new hidden BB threads per task per arm: **50 runs total**.
- Same BB `0.34.0`, Codex `gpt-5.6-sol` at low reasoning, full permission
  mode, fixture commits, and prompts in both arms.
- Baseline ran with Code Intelligence absent. Enabled used merged `main` at
  `74418af6b595f72b68585a1590a7db871926262e`.
- Correctness is the predeclared path plus required answer terms in the final
  visible answer; operations come from completed BB events. Both arms were
  rechecked after all threads completed.

## Aggregate result

| Metric | Without plugin | With plugin | Change |
| --- | ---: | ---: | ---: |
| Correct final answers | 25 / 25 | 25 / 25 | preserved (0 pp) |
| Native Code Intelligence calls | 0 | 35 | replaces shell discovery |
| Shell discovery calls | 43 | 3 | **93.0% fewer** |
| Total discovery operations | 43 | 38 | **11.6% fewer** |
| Median full-turn time | 12.1 s | 11.6 s | **4.4% lower** |

The current implementation preserved correctness while moving 35 of 38 enabled
discovery operations to typed native tools. Across this fixed task set, it used
40 fewer shell-search commands, 5 fewer discovery operations, and had a 529 ms
lower median full-turn time.

| Task / language | Operations baseline → enabled | Median turn baseline → enabled |
| --- | ---: | ---: |
| `Decode` delegation / Go | 10 → 9 | 11.8 s → 14.7 s |
| `Error` backtrace / Rust | 11 → 5 | 16.1 s → 9.0 s |
| `cJSON_Parse` / C | 9 → 6 | 11.9 s → 10.2 s |
| locale `vformat` / C++ | 7 → 10 | 13.3 s → 13.1 s |
| `Gson.fromJson` / Java | 6 → 8 | 10.0 s → 13.4 s |

## Interpretation and limits

This result supports structured native navigation on these five read-only
questions, not a claim that every programming task becomes faster. Per-task
model choices vary: Go and C++ used more discovery operations in the enabled
arm, and Java had a slower median in this five-run sample. The aggregate is a
small observational result, not a significance test or a raw ripgrep-speed
benchmark. Review the [raw rows](2026-07-31-agent-value-v3.json) and task
contract before drawing broader conclusions.

The previous [v2 report](2026-07-31-agent-value-v2.md) is retained as historical
evidence from the implementation before the Java host-snapshot fixes.
