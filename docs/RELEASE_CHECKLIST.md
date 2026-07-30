# Release checklist

Run every item from a clean clone before tagging a release.

- [ ] `npm ci`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `NODE_PATH="$(pwd)/node_modules" bb plugin build .`
- [ ] `node scripts/verify-release.mjs`
- [ ] Inspect `dist/server.meta.json` and `dist/app.meta.json`: both report
  `pluginId` `code-intelligence` and the package version.
- [ ] Install into a disposable BB data directory and confirm `running` status.
- [ ] Run literal, regex, glob, and paged exact-search smoke cases.
- [ ] Start a fresh read-only thread and confirm that a Code Intelligence tool
  invocation is recorded.
- [ ] Confirm public copy never calls the project official or faster than
  ripgrep.
- [ ] Confirm only the verified `dist` release artifacts are staged; exclude
  source maps, credentials, local BB data, and private repository paths.
