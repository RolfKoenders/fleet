# Releasing

A release is a git tag `vX.Y.Z` with a GitHub release made from the same version's section of `CHANGELOG.md`. Machines pin a tool commit, not a tag, so a release changes what a machine runs only when its owner runs `fleet update` and pushes. A config with `track: releases` in `fleet.yaml` (what `fleet new` writes) takes the newest release then: the highest `vX.Y.Z` tag, by version and not by date. A tag with a suffix such as `v3.0.0-rc.1` is not a release to `fleet update`, so a pre-release can be tagged without reaching anyone.

Every user-facing change adds a line under `## Unreleased` as it lands, so the section is ready when you release.

## Cutting a release

1. In `CHANGELOG.md`, rename `## Unreleased` to `## X.Y.Z - YYYY-MM-DD` and add a new empty `## Unreleased` above it.
2. Run `npm run site:changelog`. It writes the landing page's release pill, its What's new section and the changelog page from `CHANGELOG.md`; a test fails when you forget.
3. Commit that to `main` and push it.
4. Tag the commit and push the tag:

   ```sh
   git tag vX.Y.Z
   git push --tags
   ```

The `release` workflow then creates the GitHub release. It reads the notes from the changelog on `main`, not at the tagged commit. If the changelog has no section for the tag's version, or it is empty, the workflow fails and creates no release. Fix the changelog on `main` and run the failed workflow again. If you tagged the wrong commit, delete the tag and tag again.

## A release by hand

A tag made before the workflow existed does not run it. Create that release yourself from a checkout of `main`:

```sh
git push origin v2.0.0
gh release create v2.0.0 --verify-tag --title v2.0.0 --notes-file <(node scripts/release-notes.ts 2.0.0) --latest
```

`scripts/release-notes.ts` prints one version's section of `CHANGELOG.md` and exits non-zero when there is none, so a version without notes creates no release. It needs Node 22.18 or newer. `--latest` marks the release as the newest; leave it off when you release an older version after the fact.
