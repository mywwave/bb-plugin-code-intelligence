# Contributor readiness design

## Goal

Make Code Intelligence straightforward to develop, review, release, and
contribute to as an open-source BB plugin, without depending on GitHub
Actions. A contributor must be able to reproduce the maintainer checks
locally from a clean clone.

## Scope

This change adds contributor-facing project guidance, GitHub issue and pull
request templates, a local verification contract, and release governance. It
does not add a frontend, telemetry, a remote CI provider, or automatic GitHub
releases.

## Repository contract

### Local verification

`npm ci && npm run check` is the required local gate before a pull request is
opened or merged. `check` runs the existing typecheck, unit test, plugin build,
and release-artifact verification in a deterministic order. It must work
without network access after dependencies have been installed and without a
running BB server except for the existing `bb plugin build` prerequisite.

The generated `dist/` artifact remains versioned. The release check verifies
that its manifest and runtime assets match the source/package version, so a
code change cannot accidentally ship stale managed-install output.

An opt-in `npm run install-git-hooks` command installs a local pre-push hook
that runs `npm run check`. Hooks are never committed into `.git/hooks`, never
download dependencies, and can be bypassed with Git's normal `--no-verify`
escape hatch when a maintainer explicitly needs it.

### Contribution workflow

`CONTRIBUTING.md` documents prerequisites, setup, the required local gate,
the source-to-`dist/` workflow, branch and pull-request expectations, and how
to report bugs or propose features. It links to the public support, security,
conduct, governance, and release documents.

Pull requests use a checklist that requires a focused change, test coverage
where behavior changes, a successful local gate, and updated generated
artifacts when applicable. Issue templates separate reproducible bugs,
feature proposals, and questions so maintainers receive actionable input.

### Community and decision model

`CODE_OF_CONDUCT.md` sets an inclusive, professional interaction standard and
routes conduct reports privately to the initial maintainer through the contact
method published on that maintainer's GitHub profile; the repository does not
publish a personal address. `GOVERNANCE.md` names the repository owner as the initial
maintainer, defines review and merge authority, describes how maintainers are
added or removed, and gives a clear final-decision and conflict-resolution
path.

`SECURITY.md` directs vulnerability reports to GitHub Private Vulnerability
Reporting rather than public issues, defines the supported release line, and
states an acknowledgement/triage target.
`SUPPORT.md` directs usage questions and ideas to Discussions or issue
templates, avoiding accidental security disclosure in public threads.

### Release process

The existing release checklist becomes the canonical manual release path.
It requires a clean tree, `npm ci`, `npm run check`, a managed Git install
smoke test, a version/changelog update, and an annotated release tag. The
process explicitly states that GitHub Actions are optional: the local gate is
the authoritative evidence while Actions are unavailable. The stale GitHub
Actions workflow is removed so contributors do not see a permanently failing
remote status as a required gate.

`CHANGELOG.md` follows Keep a Changelog sections and records user-visible
changes under an Unreleased section. Releases use semantic versioning:
patches for compatible fixes, minors for compatible tools/options, majors for
breaking tool or installation contracts.

## Files

| File | Responsibility |
| --- | --- |
| `package.json` | Exposes `check` and opt-in Git-hook installation scripts. |
| `scripts/install-git-hooks.js` | Safely writes the repository-local pre-push hook. |
| `CONTRIBUTING.md` | Development and pull-request guide. |
| `CODE_OF_CONDUCT.md` | Community expectations and reporting channel. |
| `GOVERNANCE.md` | Maintainer authority and decision-making. |
| `SECURITY.md` / `SUPPORT.md` | Safe routing for security and support. |
| `CHANGELOG.md` | Versioned user-facing change record. |
| `.github/ISSUE_TEMPLATE/` | Bug, feature, and question forms/configuration. |
| `.github/PULL_REQUEST_TEMPLATE.md` | Author verification checklist. |
| `.github/workflows/ci.yml` | Removed; local `check` replaces this unavailable gate. |
| `docs/RELEASE_CHECKLIST.md` | Updated no-Actions manual release procedure. |

## Failure handling

The verification script exits non-zero at the first failed gate and leaves its
underlying command output intact. The hook only forwards that exit status; it
does not alter Git history or working-tree files. Documentation must clearly
state how to run individual checks when diagnosing a failure.

## Validation

The implementation will test hook installation in a temporary Git repository,
exercise both the successful and refusal paths (missing repository or
unexpected existing hook), and run `npm ci && npm run check` from a clean
working tree. Documentation links and referenced commands will be checked
with a small automated test or a deterministic local verifier.
