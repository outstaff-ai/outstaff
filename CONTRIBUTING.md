# Contributing to Outstaff

Thanks for helping. This guide covers how to set up, what to run before you push, and how changes get merged.

## Setup

Requirements:

- Node.js 24. The exact version is pinned in `devEngines` in `package.json`; pnpm downloads it on `pnpm install`.
- pnpm 12. Run `corepack enable` and pnpm uses the version pinned in `package.json`.

```sh
pnpm install
```

## Scripts

Run these from the repository root.

| Command          | What it does                          |
| ---------------- | ------------------------------------- |
| `pnpm lint`      | oxlint over the whole repository      |
| `pnpm typecheck` | `tsc --noEmit` in every package       |
| `pnpm test`      | vitest, one project per package       |
| `pnpm build`     | tsc, ESM output and type declarations |

Before you open a pull request, run `pnpm format && pnpm lint && pnpm typecheck && pnpm test && pnpm build`. Formatting is oxfmt (`.oxfmtrc.json`: double quotes, semicolons, trailing commas, 100 columns); linting is oxlint with the stylistic rules in `.oxlintrc.json`. CI runs `pnpm format:check`. CI runs the same checks, plus secret and hygiene scans.

## Branches and pull requests

- Branch from `main`, or from the branch your change depends on.
- **Stacked PRs are welcome.** If your change builds on another open PR, base yours on that PR's branch. When the base PR merges, retarget yours to `main`.
- **Each PR is exactly one commit.** Pull requests land with merge commits, so keep the history of your branch to a single clean commit:
  - Make your changes, then `git commit --amend` onto that one commit.
  - Push with `git push --force-with-lease` to your own branch. Never force-push to `main` or to a branch someone else is working on.
- **Commit message format:** `type(scope): summary`, for example `feat(office): poll tracker for new tickets`. The scope is optional. Use the conventional types (`feat`, `fix`, `perf`, `docs`, `style`, `refactor`, `test`, `build`, `ci`, `chore`, `revert`). CI checks the PR title and the commit subject. Keep the summary short and in the imperative mood. Add a body when the why is not obvious, and put `Closes #<issue>` in it when the PR resolves an issue.
- **Docs ship with features.** If your change adds or changes user-facing behaviour, update or add the matching page under `docs/` in the same PR.
- **Releases come from commit messages.** All packages and images share one version. A release reads the conventional commits since the last tag: `feat` makes a minor release, `fix` and `perf` a patch, and `!` or `BREAKING CHANGE:` a major. Write the commit summary for the release notes. Maintainers cut releases with the manual Release workflow, see [Releasing](https://docs.outstaff.work/guides/releasing/).
- **CI must be green.** A pull request merges only when these checks pass: lint, typecheck, test, build, the single-commit check, the conventional-commit check, the secret scan and the hygiene scan. The hygiene scan rejects personal names, emails, hostnames, internal URLs and references to other projects, so use the synthetic team `acme` in examples.

Fill in the pull request template. It asks for a summary, the linked issue, how you verified the change, and whether docs are included.

## Code style

- TypeScript in strict mode, ESM only, and no default exports.
- Keep modules small. Put tests beside the code as `*.test.ts` and run them with vitest.
- Write comments only where the why is not obvious. Match the style of the code around your change.

## Reporting bugs, asking for features, and security

- Bugs and feature requests: open an issue with the matching form. Pick the adapter or role form when you want a new integration or a new role.
- Security issues: do not open a public issue. Follow [SECURITY.md](SECURITY.md).
- Conduct concerns: follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

Outstaff is licensed under the [Apache License 2.0](LICENSE). Unless you state otherwise, any contribution you submit is licensed under the same terms, as set out in section 5 of the licence.
