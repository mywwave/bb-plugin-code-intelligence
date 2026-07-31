# Contributor Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the plugin independently developable and safe to contribute to with an authoritative local release gate instead of GitHub Actions.

**Architecture:** Preserve the existing `verify:release` pipeline as the single verification implementation. Expose it as a contributor-facing `check` command, and add a small Node installer for an opt-in managed pre-push hook. Documentation, templates, and policy files direct every contribution through that local gate and the manual release checklist.

**Tech Stack:** Node.js 22, npm, TypeScript, Vitest 3, Git, BB plugin builder.

## Global Constraints

- Do not add GitHub Actions, a hosted CI service, Husky, or any dependency solely for hooks.
- `npm ci && npm run check` is the required local verification command.
- `dist/` remains a committed managed-install artifact and must be regenerated through the existing plugin build script.
- Hook installation is opt-in, must support linked Git worktrees, and must refuse to overwrite a non-managed `pre-push` hook.
- Do not publish personal email addresses in repository policy documents.
- GitHub Private Vulnerability Reporting must be enabled in repository settings before publishing `SECURITY.md` as the security reporting route.
- Remove the unavailable GitHub Actions workflow so its status is never presented as a contribution requirement.

---

## File structure

- `package.json` — named contributor commands; `check` aliases the existing release verifier.
- `scripts/install-git-hooks.js` — standalone, exportable pre-push installer and CLI entrypoint.
- `test/install-git-hooks.test.ts` — filesystem/Git integration tests for installer behavior.
- `test/contributor-docs.test.ts` — asserts the published contribution contract is present and linked to real local files/scripts.
- `CONTRIBUTING.md` — setup, development, generated artifact, review, and PR workflow.
- `CODE_OF_CONDUCT.md` — conduct expectations and a private maintainer-report route without publishing an address.
- `GOVERNANCE.md` — initial maintainer authority, review/merge rules, maintainer changes, and dispute path.
- `SECURITY.md` — responsible disclosure through GitHub Private Vulnerability Reporting.
- `SUPPORT.md` — routes support questions away from public vulnerability disclosure.
- `CHANGELOG.md` — Keep a Changelog-style release record and semantic-version policy.
- `.github/ISSUE_TEMPLATE/*.yml` — structured bug and feature reports plus support routing.
- `.github/PULL_REQUEST_TEMPLATE.md` — required author verification checklist.
- `.github/workflows/ci.yml` — deleted; local `check` replaces it.
- `README.md` / `docs/RELEASE_CHECKLIST.md` — surface the new local development and release contract.

## Task 1: Local verification command and safe opt-in hook

**Files:**
- Create: `scripts/install-git-hooks.js`
- Create: `test/install-git-hooks.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `installPrePushHook(root?: string): Promise<string>` that returns the installed hook path or rejects without altering a foreign hook.
- Produces: `npm run check` and `npm run install-git-hooks` commands for documents and PR templates.

- [ ] **Step 1: Write the failing installer tests**

```ts
it("installs a marked executable pre-push hook that runs npm run check", async () => {
  const root = await createGitRepository();
  const hook = await installPrePushHook(root);

  expect(await readFile(hook, "utf8")).toContain("npm run check");
  expect(await stat(hook)).toMatchObject({ mode: expect.any(Number) });
});

it("refuses to replace a hook it did not install", async () => {
  const root = await createGitRepository({ prePush: "#!/bin/sh\necho custom\n" });

  await expect(installPrePushHook(root)).rejects.toThrow("refusing to overwrite");
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- test/install-git-hooks.test.ts`

Expected: FAIL because `scripts/install-git-hooks.js` and its exported installer do not exist.

- [ ] **Step 3: Implement the smallest installer**

```js
const MARKER = "# code-intelligence-managed-pre-push";
const CONTENT = `#!/usr/bin/env sh\n${MARKER}\nexec npm run check\n`;

export async function installPrePushHook(root = process.cwd()) {
  const hooksPath = await gitPath(root, ["rev-parse", "--git-path", "hooks"]);
  const target = resolve(root, hooksPath, "pre-push");
  const current = await readOptionalFile(target);
  if (current !== null && !current.includes(MARKER)) {
    throw new Error(`refusing to overwrite existing non-managed hook: ${target}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, CONTENT, { mode: 0o755 });
  await chmod(target, 0o755);
  return target;
}
```

Use `git rev-parse --git-path hooks` via `execFile` so a linked worktree's
`.git` file resolves correctly. The CLI catches errors, prints an actionable
message, and sets a non-zero exit code.

- [ ] **Step 4: Add package commands**

```json
{
  "scripts": {
    "check": "npm run verify:release",
    "install-git-hooks": "node scripts/install-git-hooks.js"
  }
}
```

Keep all existing scripts unchanged; `check` is a named alias, not a second
copy of the build/test pipeline.

- [ ] **Step 5: Run the focused test to verify it passes**

Run: `npm test -- test/install-git-hooks.test.ts`

Expected: PASS; a managed hook installs idempotently and a foreign hook is
left untouched.

- [ ] **Step 6: Commit the local gate**

```bash
git add package.json scripts/install-git-hooks.js test/install-git-hooks.test.ts
git commit -m "build: add local contributor verification gate"
```

## Task 2: Contributor contract, policies, and GitHub intake

**Files:**
- Create: `test/contributor-docs.test.ts`
- Create: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `GOVERNANCE.md`, `SECURITY.md`, `SUPPORT.md`, `CHANGELOG.md`
- Create: `.github/ISSUE_TEMPLATE/bug_report.yml`, `.github/ISSUE_TEMPLATE/feature_request.yml`, `.github/ISSUE_TEMPLATE/config.yml`, `.github/PULL_REQUEST_TEMPLATE.md`
- Delete: `.github/workflows/ci.yml`
- Modify: `README.md`, `docs/RELEASE_CHECKLIST.md`

**Interfaces:**
- Consumes: `npm run check` and `npm run install-git-hooks` from Task 1.
- Produces: stable public entry points for code contributions, conduct, security, support, and releases.

- [ ] **Step 1: Write the failing contributor-contract test**

```ts
it("publishes a local contributor gate and links every policy document", async () => {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  expect(packageJson.scripts.check).toBe("npm run verify:release");

  for (const file of [
    "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "GOVERNANCE.md",
    "SECURITY.md", "SUPPORT.md", "CHANGELOG.md",
  ]) {
    await expect(access(resolve(root, file))).resolves.toBeUndefined();
  }
  await expect(access(resolve(root, ".github/workflows/ci.yml"))).rejects.toThrow();
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- test/contributor-docs.test.ts`

Expected: FAIL because the policy files and `check` script are absent and the
old workflow still exists.

- [ ] **Step 3: Write contributor and policy documents**

`CONTRIBUTING.md` must document `npm ci && npm run check`, optional hook
installation, source versus `dist/` edits, test expectations, branch naming,
and a focused pull-request process. `CODE_OF_CONDUCT.md` must state that
concerns go privately to the initial maintainer through their GitHub-profile
contact method. `GOVERNANCE.md` must name Michael Yong as initial maintainer,
require a maintainer review before merge, explain maintainer appointment or
removal, and use the initial maintainer as final tie-breaker. `SECURITY.md`
must direct reports to GitHub Private Vulnerability Reporting and instruct the
maintainer to enable that repository setting. `SUPPORT.md` must route ordinary
questions to GitHub Discussions (or a labelled issue while Discussions is
unavailable) and warn never to publish vulnerabilities. `CHANGELOG.md` starts
with an Unreleased section and defines semantic-version meanings.

- [ ] **Step 4: Add structured GitHub templates and remove remote CI**

Create issue forms that require reproduction details for bugs and problem,
proposal, alternatives, and scope for features. Add `config.yml` links to the
support and security documents and disable blank issues. Add a PR checklist
for scope, tests, `npm run check`, docs, and regenerated `dist/` when needed.
Delete `.github/workflows/ci.yml` rather than leaving an unavailable check.

- [ ] **Step 5: Update public development and release guidance**

Replace README's bare development commands with setup, `npm run check`, and
optional hook installation. Update the release checklist to use the actual
`scripts/verify-release.js` path, require the local gate, explain the manual
managed-install smoke test, and require changelog/version/tag review. Do not
claim GitHub Actions run any check.

- [ ] **Step 6: Run the focused test to verify it passes**

Run: `npm test -- test/contributor-docs.test.ts`

Expected: PASS; every required document/template exists, package commands are
present, and the Actions workflow is absent.

- [ ] **Step 7: Commit the contributor surface**

```bash
git add CONTRIBUTING.md CODE_OF_CONDUCT.md GOVERNANCE.md SECURITY.md SUPPORT.md CHANGELOG.md README.md docs/RELEASE_CHECKLIST.md .github test/contributor-docs.test.ts
git commit -m "docs: prepare contributor workflow"
```

## Task 3: Run the manual release gate and verify the public package

**Files:**
- Modify when generated: `dist/server.js`, `dist/server.meta.json`, `dist/tree-sitter/*`
- Modify only if validation reveals stale guidance: files from Tasks 1–2

**Interfaces:**
- Consumes: `npm ci && npm run check` from Task 1 and public documents from Task 2.
- Produces: a clean working tree whose committed distribution artifact passes the same local release path contributors use.

- [ ] **Step 1: Install exact dependencies from the lockfile**

Run: `npm ci`

Expected: zero lockfile changes and no new dependencies outside `node_modules/`.

- [ ] **Step 2: Run the complete local gate**

Run: `npm run check`

Expected: TypeScript check, all Vitest suites, plugin build plus parser-asset copy,
and release-artifact verification succeed.

- [ ] **Step 3: Inspect generated distribution changes**

Run: `git status --short && git diff -- dist/`

Expected: either no `dist/` change or only deterministic files produced by the
build. Never stage source maps, credentials, or local BB data.

- [ ] **Step 4: Validate the hook CLI against this repository**

Run: `npm run install-git-hooks && .git/hooks/pre-push`

Expected: the installer reports the hook path; invoking the hook executes the
same successful `npm run check` gate.

- [ ] **Step 5: Commit deterministic generated artifacts, if any**

```bash
git add dist
git commit -m "build: refresh release artifact"
```

Skip this commit when the build leaves `dist/` unchanged.

- [ ] **Step 6: Final clean-tree verification**

Run: `git diff --check && git status --short && npm run check`

Expected: no uncommitted changes and a fully passing local contributor/release gate.
