# Prettier formatting design

## Goal

Make formatting deterministic across the repository. Contributors should have one command that rewrites supported files and the existing required validation gate should reject formatting drift without modifying the working tree.

## Approach

Use Prettier directly, without Husky, lint-staged, or a new CI workflow. The repository already has a managed pre-push hook that runs `npm run check`, so adding the formatting check to the existing verification chain gives local and pre-push coverage without introducing another hook system.

Prettier `3.8.3` will be pinned as a development dependency. The repository configuration will preserve its established broad style choices: double quotes, semicolons, trailing commas, and a 120-column print width.

## Commands and validation flow

- `npm run format` runs `prettier . --write` and rewrites every supported, non-ignored file.
- `npm run format:check` runs `prettier . --check`, makes no changes, and exits nonzero when formatting differs.
- `npm run verify` runs the formatting check before the existing typecheck and test suite.
- `npm run check` continues to run the release verification chain, which includes `verify`, the plugin build, and release-artifact validation.
- The existing managed pre-push hook continues to run `npm run check`, so it automatically inherits the formatting gate.

This keeps write behavior explicit. Validation never silently edits a contributor's working tree.

## File scope

Prettier will discover supported files from the repository root. This covers source files, tests, scripts, package metadata, YAML, JSON, and Markdown.

`.prettierignore` will exclude content that is generated, external, or unsuitable for source formatting:

- `dist/` because it is rebuilt and validated as a committed release artifact rather than formatted directly;
- `node_modules/` and `coverage/` because they are dependency/test output;
- `bench/results/` because benchmark reports and machine-generated result data are immutable evidence artifacts.

Unsupported and binary assets remain untouched by Prettier.

## Repository updates

Implementation will update:

- `package.json` and `package-lock.json` for the pinned dependency and scripts;
- `.prettierrc.json` for the repository formatting rules;
- `.prettierignore` for generated and external paths;
- `CONTRIBUTING.md` to document `npm run format` and the formatting gate;
- all currently in-scope files once, using `npm run format`.

If source formatting changes the deterministic output of the plugin builder, the regenerated `dist/` artifact will be reviewed and committed without running Prettier over it directly.

The one-time formatting pass may produce a broad mechanical diff. It must not include behavioral edits.

## Verification and failure behavior

Implementation is complete when:

1. `npm run format:check` passes on the formatted tree.
2. A deliberately misformatted temporary supported file makes `npm run format:check` fail, and `npm run format` repairs it.
3. `npm run check` passes, including typechecking, tests, plugin build, and release-artifact validation.
4. Any deterministic `dist/` refresh caused by the source pass is committed, and a subsequent full gate leaves `git diff -- dist/` empty.

If the initial formatting pass exposes syntax Prettier cannot parse, implementation stops and narrows the cause rather than adding a broad ignore rule. Generated paths are the only planned exclusions.
