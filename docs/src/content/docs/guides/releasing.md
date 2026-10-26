---
title: Releasing
description: How a maintainer cuts a release, what it publishes, and the one-time setup for npm trusted publishing and the release token.
---

One manual workflow, **Release** (`.github/workflows/release.yml`), versions and publishes everything together. All published packages share one version (lockstep), and so does the catalog the images carry. The version and the notes come from the [conventional commits](https://www.conventionalcommits.org/) since the last `v*` tag, so nothing is written by hand.

## Cut a release

1. Open **Actions > Release > Run workflow** on `main`.
2. Keep **dry_run** on for the first run. It prints the version and the release notes in the step summary and runs lint, typecheck, test and build and packs the tarballs, but changes and publishes nothing.
3. Check the version and notes, then run it again with **dry_run** off.

`level` is `auto` by default and follows the commits:

| Commit                                             | Bump  |
| -------------------------------------------------- | ----- |
| `!` after the type, or a `BREAKING CHANGE:` footer | major |
| `feat`                                             | minor |
| `fix`, `perf`                                      | patch |
| anything else                                      | none  |

While the version is `0.x`, a breaking change bumps the minor instead of the major, because 0.x makes no stability promise. With no releasable commit, `auto` stops with "nothing to release". Choose `patch`, `minor` or `major` to force a level; `major` is how you reach `1.0.0`. The first release has no tag, starts from `0.0.0`, and becomes `0.1.0` as soon as one `feat` landed.

To preview locally, run `node scripts/release.ts --dry-run`. It prints the next version and notes and writes nothing.

## What happens, in order

1. **Version and notes.** `scripts/release.ts` writes the version into every published `packages/*/package.json` and `integrations/*/*/package.json` and prepends the notes to `CHANGELOG.md`. The notes group commits into Breaking changes, Features, Fixes, Performance and Other (`docs`, `refactor`, `revert`, `build`, `ci`). `chore`, `test` and `style` commits stay out.
2. **Verify.** Version pinning, format, lint, typecheck, test and build must pass.
3. **Commit and tag, locally.** The commit is `chore(release): vX.Y.Z` and the tag is `vX.Y.Z`. Nothing has left the runner yet.
4. **Publish to npm.** `pnpm pack` turns every `workspace:*` dependency into the exact release version, and `npm publish --provenance` publishes `outstaff` and the `@outstaff/*` packages. A package whose version is already on npm is skipped, so a run that failed halfway can simply be started again with the same level.
5. **Push.** One atomic push of the release commit to `main` and the tag. If publishing failed, `main` and the tags are untouched.
6. **GitHub release.** Created from the tag with the notes. `0.x` releases are marked as prereleases.

Two other workflows finish the release by themselves:

- **Images.** The tag push starts the Images workflow (`.github/workflows/images.yml`), which builds and publishes `ghcr.io/outstaff-ai/office` and `ghcr.io/outstaff-ai/agent` for `linux/amd64` and `linux/arm64` with the same version. The images are built after the npm packages are out. Release does not build images itself.
- **Docs.** The push to `main` deploys the docs site.

If the push is rejected because `main` moved during the run, the packages are already on npm. Update the branch, run Release again with the same level and it skips what is published; if `main` gained new commits the auto level may differ, so pick the level explicitly to publish the same version.

## One-time setup

### npm trusted publishing

No long-lived npm token is stored. For each package (`outstaff` and every `@outstaff/*`):

1. A package must exist before it can have a trusted publisher. For a package that was never published, create it with a first manual `npm publish --access public` of a placeholder from a maintainer account, or a granular token used once.
2. On npmjs.com, open the package > **Settings** > **Trusted Publisher** > **GitHub Actions**, and enter organization `outstaff-ai`, repository `outstaff`, workflow filename `release.yml`. Leave the environment empty.
3. Under **Publishing access**, choose "Require two-factor authentication and disallow tokens".

The workflow has `id-token: write`, which is what npm exchanges for a short-lived publish credential and what signs the provenance statement. Trusted publishing needs npm 11.5.1 or newer, which the pinned Node 24 includes.

### RELEASE_TOKEN and the main ruleset

The release pushes a commit to `main` and a tag, which the `main` ruleset (pull request, status checks, merge queue) rejects for normal actors. Create the repository secret `RELEASE_TOKEN`:

1. Make a fine-grained token (or a GitHub App installation token) for the `outstaff-ai/outstaff` repository only, with **Contents: read and write**.
2. Add the account or App as a **bypass actor** of the `main` ruleset, with bypass mode **Always**. The release push is the only thing it is for, and the ruleset itself stays as it is. Use a dedicated account or App for it, not a person.
3. Save the token as the repository secret `RELEASE_TOKEN`.

The token is used for the checkout, the push and `gh release create`. Using it, rather than `GITHUB_TOKEN`, is also what lets the tag push start the Images workflow, because events caused by `GITHUB_TOKEN` do not start other workflows.

Restrict who may run the workflow by limiting write access, and consider a protected `release` environment if you want an approval before every run.
