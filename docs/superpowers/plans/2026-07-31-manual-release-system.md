# Manual Release System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-first, guarded release workflow and publish the first GitHub Release `v0.1.0` without GitHub Actions.

**Architecture:** A pure local preparation script validates input before updating version metadata, changelog, and `dist/`. A separate publication script verifies the committed, pushed release state before it creates an annotated tag and calls `gh release create`. Tests exercise all local preconditions in temporary repositories; the one real publication occurs only after the release commit and full gate are pushed.

**Tech Stack:** Node.js 22, npm lockfile v3, Git, GitHub CLI, Vitest 3, BB plugin builder.

## Global Constraints

- No GitHub Actions, hosted CI service, or automatic publish on push.
- Package versions are SemVer without a leading `v`; tags are `v<version>`.
- `release:prepare` never creates a commit, tag, push, or GitHub Release.
- `release:publish` must require a clean tree, `HEAD == origin/main`, package/tag match, an absent local/remote tag, and a passing `npm run check`.
- A failed precondition must not invoke `git tag`, `git push`, or `gh release create`.
- The first published release is `v0.1.0`.

---

## Task 1: Test and implement local release preparation

**Files:**
- Create: `scripts/prepare-release.js`
- Create: `test/prepare-release.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `prepareRelease(version: string, root?: string): Promise<void>`.
- Produces: `npm run release:prepare -- <version>`.

- [ ] **Step 1: Write failing preparation tests**

```ts
it("updates package metadata and promotes Unreleased changelog entries", async () => {
  const root = await releaseFixture();

  await prepareRelease("1.2.3", root);

  expect(await packageVersion(root)).toBe("1.2.3");
  expect(await lockfileRootVersion(root)).toBe("1.2.3");
  expect(await readFile(join(root, "CHANGELOG.md"), "utf8")).toContain("## [1.2.3] - 2026-07-31");
});

it("rejects an invalid version or dirty repository before writing", async () => {
  const root = await releaseFixture();
  await expect(prepareRelease("v1.2.3", root)).rejects.toThrow("SemVer");
  await writeFile(join(root, "scratch.txt"), "dirty\n");
  await expect(prepareRelease("1.2.3", root)).rejects.toThrow("clean working tree");
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `npm test -- test/prepare-release.test.ts`

Expected: FAIL because `prepareRelease` does not exist.

- [ ] **Step 3: Implement the local-only preparer**

```js
export async function prepareRelease(version, root = process.cwd()) {
  assertSemVer(version);
  await assertCleanTree(root);
  const packageJson = await readJson(join(root, "package.json"));
  const lockfile = await readJson(join(root, "package-lock.json"));
  const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
  assertUnreleasedContent(changelog);
  packageJson.version = version;
  lockfile.version = version;
  lockfile.packages[""].version = version;
  await writeReleaseFilesAtomically(root, packageJson, lockfile, promoteUnreleased(changelog, version));
  await run(root, "npm", ["run", "build:plugin"]);
}
```

Validate all inputs before the first write; use the current UTC date for the
changelog heading. The CLI takes exactly one version argument and prints the
files it changed.

- [ ] **Step 4: Add the package command**

```json
"release:prepare": "node scripts/prepare-release.js"
```

- [ ] **Step 5: Run the focused test and typecheck**

Run: `npm test -- test/prepare-release.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit preparation support**

```bash
git add package.json scripts/prepare-release.js test/prepare-release.test.ts
git commit -m "build: add release preparation command"
```

## Task 2: Test and implement guarded publication

**Files:**
- Create: `scripts/publish-release.js`
- Create: `test/publish-release.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `assertPublishable(version: string, root?: string): Promise<void>`.
- Produces: `npm run release:publish -- <version>`.

- [ ] **Step 1: Write failing publisher-precondition tests**

```ts
it("rejects a package/tag mismatch before any external command", async () => {
  const root = await publishFixture({ packageVersion: "1.2.3" });

  await expect(assertPublishable("1.2.4", root)).rejects.toThrow("does not match package.json");
});

it("rejects when HEAD is not the pushed origin/main commit", async () => {
  const root = await publishFixture({ aheadOfOrigin: true });

  await expect(assertPublishable("1.2.3", root)).rejects.toThrow("must equal origin/main");
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `npm test -- test/publish-release.test.ts`

Expected: FAIL because `assertPublishable` does not exist.

- [ ] **Step 3: Implement publisher guards and CLI**

```js
export async function assertPublishable(version, root = process.cwd()) {
  assertSemVer(version);
  await assertCleanTree(root);
  assert.equal((await readPackage(root)).version, version);
  assert.equal(await git(root, ["rev-parse", "HEAD"]), await git(root, ["rev-parse", "origin/main"]));
  await assertTagAbsent(root, `v${version}`);
}

export async function publishRelease(version, root = process.cwd()) {
  await assertPublishable(version, root);
  await run(root, "npm", ["run", "check"]);
  await run(root, "git", ["tag", "-a", `v${version}`, "-m", `Release v${version}`]);
  await run(root, "git", ["push", "origin", `v${version}`]);
  await run(root, "gh", ["release", "create", `v${version}`, "--verify-tag", "--generate-notes", "--fail-on-no-commits"]);
}
```

Check the remote tag through `git ls-remote --tags origin` before the local
tag is made. Pass every command through one injectable runner so tests prove
guards stop the external calls.

- [ ] **Step 4: Add the package command**

```json
"release:publish": "node scripts/publish-release.js"
```

- [ ] **Step 5: Run the focused test and typecheck**

Run: `npm test -- test/publish-release.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit publisher support**

```bash
git add package.json scripts/publish-release.js test/publish-release.test.ts
git commit -m "build: add guarded release publisher"
```

## Task 3: Document the release workflow and prepare `0.1.0`

**Files:**
- Modify: `README.md`, `CONTRIBUTING.md`, `docs/RELEASE_CHECKLIST.md`, `CHANGELOG.md`, `package.json`, `package-lock.json`, `dist/**`
- Test: `test/contributor-docs.test.ts`

- [ ] **Step 1: Extend the failing contributor-contract test**

```ts
expect(packageJson.scripts["release:prepare"]).toBe("node scripts/prepare-release.js");
expect(packageJson.scripts["release:publish"]).toBe("node scripts/publish-release.js");
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `npm test -- test/contributor-docs.test.ts`

Expected: FAIL until both release scripts are present and public guidance links
to the manual release sequence.

- [ ] **Step 3: Update documentation and changelog**

Document: prepare → inspect/commit → push `main` → `npm run check` → publish.
Move the current Unreleased contributor-readiness entries into `0.1.0` and add
the existing code-search, structural-context, managed-install, and release
verification capabilities to the same first-release section.

- [ ] **Step 4: Run release preparation**

Run: `npm run release:prepare -- 0.1.0`

Expected: package metadata, lockfile root version, changelog heading, and
`dist/` metadata/artifact change together without creating a commit or tag.

- [ ] **Step 5: Commit the prepared release**

```bash
git add README.md CONTRIBUTING.md docs/RELEASE_CHECKLIST.md CHANGELOG.md package.json package-lock.json dist test/contributor-docs.test.ts
git commit -m "release: prepare v0.1.0"
```

## Task 4: Publish and verify the first release

**Files:** None expected.

- [ ] **Step 1: Run the full local release gate**

Run: `npm ci && npm run check`

Expected: all tests, build, metadata verification, and committed-artifact guard pass.

- [ ] **Step 2: Push the release commit**

Run: `git push origin main`

Expected: local `HEAD` equals `origin/main`.

- [ ] **Step 3: Publish the release**

Run: `npm run release:publish -- 0.1.0`

Expected: annotated `v0.1.0` tag is pushed, then a published GitHub Release is
created from that exact tag.

- [ ] **Step 4: Verify the public release**

Run: `gh release view v0.1.0 --repo mywwave/bb-plugin-code-intelligence --json tagName,isDraft,isPrerelease,targetCommitish,url`

Expected: `tagName` is `v0.1.0`, draft and prerelease are false, target points
to the pushed release commit, and the URL resolves to the public release.
