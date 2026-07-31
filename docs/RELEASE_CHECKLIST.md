# Release checklist

Run every item from a clean clone before tagging a release.

- [ ] `npm ci`
- [ ] `npm run check` (typecheck, tests, plugin build, parser-asset copy, and
  `node scripts/verify-release.js`; fails when generated `dist/` is not
  committed).
- [ ] Inspect `dist/server.meta.json`: it reports `pluginId`
  `code-intelligence` and the package version.
- [ ] Install into a disposable BB data directory and confirm `running` status.
- [ ] Run literal, regex, glob, and paged exact-search smoke cases.
- [ ] Start a fresh read-only thread and confirm that a Code Intelligence tool
  invocation is recorded.
- [ ] Confirm public copy never calls the project official or faster than
  ripgrep.
- [ ] Confirm only the verified `dist` release artifacts are staged; exclude
  source maps, credentials, local BB data, and private repository paths.
- [ ] Update `CHANGELOG.md`, version `package.json`, and review the generated
  `dist/` metadata before creating an annotated release tag.
- [ ] Confirm GitHub Private Vulnerability Reporting remains enabled.

GitHub Actions are not a release gate for this repository. Preserve the local
command output or managed-install smoke-test notes with the release instead.
