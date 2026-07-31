# Stable managed-update channel design

## Goal

Provide a conservative update channel for managed Git installs of Code
Intelligence. Regular users track only released commits; contributors can
continue tracking the development branch.

## Channels

- `stable` is the public managed-install branch. It points only at the exact
  commit of the latest published annotated release tag.
- `main` remains the development branch. It may contain unreleased work and is
  documented only for contributors and early testers.
- A tag such as `v1.2.3` is a fixed installation point, not an update channel:
  BB treats Git tags as pinned.

The standard installation source becomes:

```text
git:https://github.com/mywwave/bb-plugin-code-intelligence.git@stable
```

## Release flow

`release:prepare` remains local-only and continues to prepare a release on
`main`. `release:publish` retains its existing clean-tree, matching-version,
and `HEAD == origin/main` gates. After its complete local verification, it:

1. creates and pushes the annotated version tag;
2. creates the GitHub Release from that tag;
3. fast-forwards `origin/stable` to that exact tag commit.

The stable-branch push is intentionally last. A failed GitHub Release never
exposes an unreleased commit to managed-install users. If the final branch push
fails (for example, because `stable` diverged), the release remains published
but the command fails loudly and users remain on the previous known-good
stable commit until the maintainer resolves that divergence.

## User behavior

BB does not auto-install third-party plugin updates. A user who installed from
`@stable` manually checks and applies a compatible update through Tools →
Plugins, or with `bb plugin outdated` followed by
`bb plugin update code-intelligence`. BB resolves the moved branch commit,
checks the declared BB and SDK engine ranges, stages it, and rolls back on a
failed activation.

## Validation

Unit coverage verifies that publication pushes the `stable` ref only after the
release command succeeds, and that a stable-push failure is surfaced. The
repository release gate remains `npm run check`; documentation tests ensure the
public install command points at `@stable`.
