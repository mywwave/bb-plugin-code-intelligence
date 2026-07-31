# Manual release system design

## Goal

Provide a repeatable, local-first release workflow for Code Intelligence that
creates a versioned managed-install artifact, annotated Git tag, and published
GitHub Release without GitHub Actions.

## Release contract

The first release is `v0.1.0`. Later releases use a SemVer version without the
`v` prefix for package files and the matching `v<version>` Git tag.

`npm run release:prepare -- <version>` is local-only. It accepts exactly one
valid SemVer version, requires a clean repository, updates `package.json` and
`package-lock.json`, promotes the `CHANGELOG.md` Unreleased entries into a
dated version section, and rebuilds the committed `dist/` artifact. It does
not create a commit, tag, push, or GitHub Release.

The maintainer reviews and commits those generated changes, pushes `main`, and
runs `npm run check`. The existing gate remains authoritative: it checks types,
tests, builds the plugin, validates release metadata, and rejects an
uncommitted `dist/` artifact.

`npm run release:publish -- <version>` performs the external publication only
when the working tree is clean, `HEAD` equals `origin/main`, the package
version matches, the annotated tag does not yet exist, and `npm run check`
passes. It creates and pushes `v<version>`, then runs `gh release create` with
`--verify-tag`, generated GitHub notes, and `--fail-on-no-commits`. Any failed
precondition stops before a tag or release is created.

## Components

| File | Responsibility |
| --- | --- |
| `scripts/prepare-release.js` | Pure local release preparation with SemVer, clean-tree, changelog, package, lockfile, and artifact checks. |
| `scripts/publish-release.js` | Guarded external tag/push/GitHub Release publisher using `git` and authenticated `gh`. |
| `test/prepare-release.test.ts` | Temporary-repository tests for accepted preparation and rejected invalid/dirty input. |
| `test/publish-release.test.ts` | Tests that precondition failures stop before external commands are reached. |
| `package.json` | Exposes `release:prepare` and `release:publish`. |
| `CHANGELOG.md` | Records `0.1.0` with the public plugin and contributor-readiness changes. |
| `docs/RELEASE_CHECKLIST.md` / `README.md` | Documents the command sequence and no-Actions release boundary. |

## Failure handling

Preparation writes only package metadata, changelog, and generated `dist/`.
It checks all inputs before the first write. Publication never creates a tag
until every local and remote precondition passes; a failed GitHub Release call
leaves the pushed annotated tag intact and reports the exact `gh` error for a
maintainer to resolve.

## Validation

Tests must show an invalid version, dirty tree, missing changelog entry, and
package/tag mismatch are rejected. A real `v0.1.0` publication must run
`npm ci && npm run check`, be committed and pushed before publishing, and be
verified through `gh release view v0.1.0` after creation.
