# Validation record

Date: 2026-07-31

## Clean install

An isolated BB `0.34.0` server and host daemon were started with a fresh data
directory. The Plugins experiment was enabled only in that temporary instance.
Installing this repository by local path produced:

- plugin id: `code-intelligence`;
- display name: Code Intelligence;
- version: `0.1.0`;
- status: `running` with no status detail;
- CLI command: `bb code-intelligence`;
- compatible frontend bundle stamped for plugin SDK `0.4.1`.

`bb code-intelligence status` returned an empty index/feedback summary without
an error before the first repository use.

## Fresh-thread smoke test

A separate, read-only Codex thread was started against this repository in the
isolated BB instance. For a known release-verifier symbol, the agent invoked
`instant_grep` once. The tool used the `BB host-file snapshot` engine, returned
complete exact hits without truncation, and completed in 397 ms. The agent then
reported the defining file and correctly summarized the verifier's purpose.

The thread performed no file edits. This proves plugin installation, agent-tool
registration, active-workspace routing, exact search, and tool-result
consumption in a fresh BB process. It is a smoke test, not a comparative
performance benchmark; see [BENCHMARK.md](BENCHMARK.md) for the required
benchmark protocol.
