# Release checklist

Run every item from a clean clone before tagging a release.

- [ ] `npm run release:prepare -- <version>` from a clean tree.
- [ ] Inspect package and lockfile versions, the dated `CHANGELOG.md` entry,
  and the regenerated `dist/server.meta.json`.
- [ ] Commit the version, changelog, and `dist/` changes, then `git push origin main`.
- [ ] `npm ci && npm run check` against the pushed release commit (typecheck,
  tests, plugin build, parser-asset copy, metadata validation, and committed-
  artifact guard).
- [ ] Install into a disposable BB data directory and confirm `running` status.
- [ ] Run literal, regex, glob, and paged exact-search smoke cases.
- [ ] Start a fresh read-only thread and confirm that a Code Intelligence tool
  invocation is recorded.
- [ ] Confirm public copy never calls the project official or faster than
  ripgrep.
- [ ] Confirm only the verified `dist` release artifacts are staged; exclude
  source maps, credentials, local BB data, and private repository paths.
- [ ] Confirm GitHub Private Vulnerability Reporting remains enabled.
- [ ] `npm run release:publish -- <version>`.
- [ ] `gh release view v<version>` confirms a published, non-prerelease GitHub
  Release targeting the pushed release commit.

GitHub Actions are not a release gate for this repository. Preserve the local
command output or managed-install smoke-test notes with the release instead.
