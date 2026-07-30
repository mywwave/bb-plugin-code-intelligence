# Maintainer proposal

Code Intelligence is a standalone prototype for native code-discovery and
static-context tools in BB. No issue, RFC, or pull request has been opened in
the BB repository.

The prototype's value is a concise tool contract, exact evidence for known
queries, workspace/host-aware routing, bounded exploration, and explicit
static-analysis limits. It does not intercept shell commands and it does not
claim to be faster than ripgrep.

If BB maintainers choose to adopt it later, the expected integration is an
opt-in official plugin under `official-plugins/code-intelligence`. The future
upstream change would use the BB workspace SDK/test harness, register a
catalog entry and packaged build, and add integration coverage. That decision
is deliberately separate from this repository's public prototype release.
