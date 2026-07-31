# Contributing to Code Intelligence

Thanks for improving Code Intelligence for BB. This project ships a committed
server-only plugin artifact, so source changes and release output are reviewed
together.

## Setup

Requirements:

- Node.js 22 or newer;
- npm;
- BB 0.34 or newer on `PATH` for the plugin build step.

From a fresh clone:

```bash
npm ci && npm run check
```

`npm run check` is the required local gate. It runs type checking, the Vitest
suite, builds the managed-install plugin artifact, copies parser assets, and
validates the release artifact. GitHub Actions are intentionally not required
for this repository. If it reports that `dist/` differs, review and commit the
generated artifact before opening a pull request.

To run the same gate before each push, opt in to the managed hook:

```bash
npm run install-git-hooks
```

The installer refuses to replace a pre-existing hook it does not own. Remove
the managed hook manually if you no longer want it.

## Development workflow

1. Create a focused branch from current `main`.
2. Change source under `src/` or the plugin entrypoint `server.ts`.
3. Add or update a focused test under `test/` before changing behavior.
4. Run the smallest relevant test, then `npm run check`.
5. Review `git diff -- dist/`. Commit generated `dist/` files only when the
   build changed them; never commit source maps, credentials, local BB data,
   or `node_modules/`.
6. Open a focused pull request using the repository template.

For rapid iteration, run a single test file with:

```bash
npm test -- test/instant-grep.test.ts
```

## Pull requests

Keep each pull request to one reviewable outcome. Explain the user-facing
effect, state how it was validated, and update documentation whenever tool
contracts, install steps, or release behavior change. A maintainer must review
and merge pull requests; passing a local gate does not replace review.

## Where to ask or report

- Read [SUPPORT.md](SUPPORT.md) for usage questions and ideas.
- Read [SECURITY.md](SECURITY.md) before reporting a vulnerability.
- Read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations.
- Read [GOVERNANCE.md](GOVERNANCE.md) for maintainer decisions and merge rules.
- Read [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) for the manual
  release path.

## Releases

Only a maintainer publishes releases. Run `npm run release:prepare -- <version>`
from a clean tree, review and commit the version, changelog, and generated
`dist/` changes, then push `main`. After `npm run check` passes against that
pushed commit, run `npm run release:publish -- <version>`. The publisher
creates an annotated `v<version>` tag and a GitHub Release, then promotes the
managed-install `stable` branch to that tag's commit. It refuses to publish an
unpushed, dirty, mismatched, or already tagged release. If stable promotion
fails, resolve the branch divergence before telling users an update is ready.
