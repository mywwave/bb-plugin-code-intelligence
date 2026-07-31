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
shell-search calls, and wall time from fresh threads.

## Reporting

Publish raw machine-readable data, the runner command, and a short narrative
of failures. Separate local-server-root and remote-host-snapshot results. Do
not merge them into a single speed number because they have different I/O
paths.

## Published evidence

The first small agent-routing pilot is published under
[`bench/results/`](../bench/results/). The current cross-language suite is
defined in [`bench/tasks/agent-value-v2.json`](../bench/tasks/agent-value-v2.json)
and publishes its own raw result rows and aggregate report under the same
results directory. Neither is a statistically general performance claim.
