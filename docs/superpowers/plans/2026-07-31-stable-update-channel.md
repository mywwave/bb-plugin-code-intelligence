# Stable Update Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish managed Git plugin updates through a release-only `stable` branch.

**Architecture:** Keep `main` as the development and release-preparation branch. Extend the guarded publisher to tag and release the verified commit, then promote `origin/stable` to that exact tag commit. Public installation tracks `stable`.

**Tech Stack:** Node.js ESM release scripts, Vitest, Git, GitHub CLI, Markdown.

## Global Constraints

- BB Git updates track branches; tags and commit hashes are pinned.
- `stable` moves only after the GitHub Release succeeds.
- Existing release gates remain unchanged.
- `npm run check` remains the complete local gate; no GitHub Actions are added.

---

### Task 1: Make the release publisher promote `stable`

**Files:**
- Modify: `scripts/publish-release.js`
- Modify: `scripts/publish-release.d.ts`
- Test: `test/publish-release.test.ts`

**Interfaces:**
- Produces: `publishRelease(version, root?, options?)`; `options.runCommand(root, command, args, options)` is a test seam and defaults to the existing command runner.

- [ ] **Step 1: Write failing release-order tests**

Create a bare `origin` fixture. Test that publication pushes
`refs/tags/v1.2.3:refs/heads/stable` only after `gh release create`; verify the
remote stable ref equals HEAD. Test that a final stable-push failure is surfaced
after the GitHub Release command was attempted.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/publish-release.test.ts`

Expected: FAIL because the publisher lacks the runner option and stable push.

- [ ] **Step 3: Implement minimal promotion**

Default the optional runner to the current subprocess helper. After the GitHub
Release command, run:

```js
await runner(repositoryRoot, "git", ["push", "origin", `refs/tags/${tag}:refs/heads/stable`], { stdio: "inherit" });
```

Update the declaration file for the optional runner.

- [ ] **Step 4: Run focused verification and commit**

Run: `npm test -- test/publish-release.test.ts && npm run typecheck`

Commit: `git commit -m "feat: promote stable release channel"`

### Task 2: Publish the stable-channel contract

**Files:**
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `docs/RELEASE_CHECKLIST.md`
- Modify: `docs/APPROACH.md`
- Modify: `docs/VALIDATION.md`
- Test: `test/contributor-docs.test.ts`

**Interfaces:**
- Produces: the one public install source `git:https://github.com/mywwave/bb-plugin-code-intelligence.git@stable`.

- [ ] **Step 1: Write failing documentation assertions**

Require `@stable` in public README install text, require stable promotion in
the checklist, and reject the old public `@main` source.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/contributor-docs.test.ts`

Expected: FAIL because the repository still publishes `@main`.

- [ ] **Step 3: Update documentation**

Move public installation to `@stable`, state that BB update checks and applies
are user-confirmed, retain `@main` only for development, and describe final
stable promotion in maintainer docs. Update approach and validation references.

- [ ] **Step 4: Run focused verification and commit**

Run: `npm test -- test/contributor-docs.test.ts && git diff --check`

Commit: `git commit -m "docs: publish stable update channel"`

### Task 3: Establish and validate the initial channel

**Files:** None.

- [ ] **Step 1: Run the complete local gate**

Run: `npm ci && npm run check`

Expected: typecheck, all tests, build, metadata verification, and committed-artifact verification pass.

- [ ] **Step 2: Push the commits and set the first stable pointer**

Run: `git push origin main && git push origin refs/tags/v0.1.0:refs/heads/stable`

Expected: `origin/stable` equals the published `v0.1.0` commit.

- [ ] **Step 3: Verify remote release state**

Run: `git ls-remote --heads --tags origin stable v0.1.0 && gh release view v0.1.0 --json tagName,isDraft,isPrerelease,targetCommitish,url`

Expected: stable and v0.1.0 resolve to the same commit and GitHub reports a published non-prerelease release.
