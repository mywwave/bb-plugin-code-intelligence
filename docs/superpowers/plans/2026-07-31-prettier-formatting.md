# Prettier Formatting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic repository-wide Prettier formatting with an explicit write command and a non-mutating check in the existing required validation gate.

**Architecture:** Prettier runs directly from npm scripts and discovers supported files from the repository root. A repository config fixes style choices, an ignore file protects generated evidence and build output, and the existing `verify` → `verify:release` → `check` chain carries the new formatting check into the managed pre-push hook.

**Tech Stack:** Node.js 22+, npm, Prettier 3.8.3, existing TypeScript/Vitest/release checks.

## Global Constraints

- Pin Prettier exactly at version `3.8.3`; do not add Husky, lint-staged, or a CI workflow.
- Preserve double quotes, semicolons, trailing commas, and a 120-column print width.
- `npm run format` may rewrite supported source files; `npm run format:check` and `npm run check` must never rewrite them.
- Exclude `dist/`, `node_modules/`, `coverage/`, and `bench/results/` from direct Prettier formatting; commit a deterministic `dist/` refresh if rebuilding formatted source changes it.
- The one-time formatting diff must remain mechanical and contain no behavioral edits.

---

## File map

- Create `.prettierrc.json`: repository-wide Prettier style configuration.
- Create `.prettierignore`: generated/external path boundary for both write and check commands.
- Modify `package.json`: pinned dependency plus `format`, `format:check`, and updated `verify` scripts.
- Modify `package-lock.json`: npm-resolved lock entry for Prettier 3.8.3.
- Modify supported source, test, script, JSON, YAML, and Markdown files: one-time mechanical formatting only.
- Modify `CONTRIBUTING.md`: contributor commands and formatting-gate behavior.
- Modify `dist/server.js` only if the plugin builder deterministically refreshes the committed artifact after source formatting.

### Task 1: Prettier dependency, commands, and repository formatting

**Files:**

- Create: `.prettierrc.json`
- Create: `.prettierignore`
- Modify: `package.json:36-60`
- Modify: `package-lock.json`
- Modify: all Prettier-supported, non-ignored repository files reported by `npm run format`

**Interfaces:**

- Consumes: the existing `verify` npm script and root-level repository layout.
- Produces: `npm run format`, `npm run format:check`, and a `verify` script that begins with `npm run format:check`.

- [ ] **Step 1: Install the exact development dependency**

Run:

```bash
npm install --save-dev --save-exact prettier@3.8.3
```

Expected: `package.json` contains `"prettier": "3.8.3"` under `devDependencies`, and `package-lock.json` records the same resolved version.

- [ ] **Step 2: Add the formatting configuration and ignore boundary**

Create `.prettierrc.json` with exactly:

```json
{
  "printWidth": 120,
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all"
}
```

Create `.prettierignore` with exactly:

```gitignore
dist/
node_modules/
coverage/
bench/results/
```

- [ ] **Step 3: Add npm scripts and connect the validation gate**

Make the relevant `package.json` scripts exactly:

```json
"format": "prettier . --write",
"format:check": "prettier . --check",
"test": "vitest run",
"typecheck": "tsc --noEmit --noUnusedLocals --noUnusedParameters",
"verify": "npm run format:check && npm run typecheck && npm test"
```

Leave `check`, `verify:release`, and the managed pre-push hook unchanged; they already reach `verify` through the existing command chain.

- [ ] **Step 4: Run the new check before formatting to prove it detects existing drift**

Run:

```bash
npm run format:check
```

Expected: exit code 1 with one or more `[warn]` paths because the existing tree has not yet received its one-time formatting pass. If it unexpectedly passes, continue: the command itself and its non-mutating behavior are still established.

- [ ] **Step 5: Apply the one-time mechanical formatting pass**

Run:

```bash
npm run format
```

Expected: Prettier reports checked files and rewrites only supported, non-ignored files. Review `git diff --stat` and `git diff -- dist/`; the latter must be empty.

- [ ] **Step 6: Prove check failure and repair on a deliberately malformed supported file**

Create an untracked `.prettier-smoke-test.js` containing exactly:

```js
const values=[1,2,3]
```

Run:

```bash
npm run format:check
```

Expected: exit code 1 and `.prettier-smoke-test.js` is named as unformatted.

Then run:

```bash
npx prettier .prettier-smoke-test.js --write
npm run format:check
```

Expected: the smoke file becomes `const values = [1, 2, 3];`, and the repository check passes. Remove `.prettier-smoke-test.js` with an apply-patch deletion before staging.

- [ ] **Step 7: Review and commit the formatter setup plus mechanical pass**

Run:

```bash
git diff --check
git diff --name-status
git diff -- dist/
```

Expected: no whitespace errors, no `dist/` diff, and no files outside the intended formatting/configuration scope.

Commit:

```bash
git add .prettierrc.json .prettierignore package.json package-lock.json .github bench docs scripts src test server.ts '*.md' '*.json'
git commit -m "chore: add prettier formatting gate"
```

Before committing, verify `.prettier-smoke-test.js` is absent from `git status --short`.

### Task 2: Contributor documentation and full release verification

**Files:**

- Modify: `CONTRIBUTING.md:21-25`
- Modify: `CONTRIBUTING.md:36-45`

**Interfaces:**

- Consumes: `npm run format`, `npm run format:check`, and the updated `npm run check` chain from Task 1.
- Produces: contributor guidance that distinguishes automatic rewriting from non-mutating validation.

- [ ] **Step 1: Document formatting in setup and the development workflow**

Update the required-gate paragraph to state that `npm run check` first verifies Prettier formatting, then runs typechecking, Vitest, the plugin build, asset copying, and release-artifact validation.

Add this command block before the numbered development workflow:

````markdown
Format all supported source and documentation files before validation:

```bash
npm run format
```

`npm run format:check` reports formatting drift without modifying files. Generated
release output under `dist/` and benchmark evidence under `bench/results/` are
excluded from source formatting.
````

Update workflow step 4 to read: `Run npm run format, the smallest relevant test, then npm run check.` with the command names formatted as inline code.

- [ ] **Step 2: Verify documentation formatting**

Run:

```bash
npm run format -- CONTRIBUTING.md
npm run format:check
```

Expected: `CONTRIBUTING.md` is formatted and the repository-wide check passes.

- [ ] **Step 3: Run the complete required gate**

Run:

```bash
npm run check
```

Expected: formatting check, TypeScript typecheck, Vitest, plugin build, and release verification pass. If clean-dist reports a deterministic `dist/server.js` refresh caused by formatted source, review and include that generated artifact in Step 5; do not run Prettier over it directly.

- [ ] **Step 4: Confirm generated output and working-tree scope**

Run:

```bash
git diff --check
git diff -- dist/
git status --short
```

Expected: no whitespace errors, and only the intended documentation update plus any reviewed deterministic `dist/server.js` refresh remain unstaged.

- [ ] **Step 5: Commit contributor documentation**

```bash
git add CONTRIBUTING.md dist/server.js docs/superpowers/specs/2026-07-31-prettier-formatting-design.md docs/superpowers/plans/2026-07-31-prettier-formatting.md
git commit -m "docs: document prettier workflow"
```

- [ ] **Step 6: Final clean verification**

Run:

```bash
npm run format:check
npm run check
git status --short --branch
```

Expected: both commands pass and the branch is clean, ahead of `github/main` only by the design, plan, formatter, and documentation commits.
