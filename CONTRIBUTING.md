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

## End-to-end test

`e2e/` runs the acme loop on Docker Compose, with the real office and agent images and stand-ins for everything outside them. It takes a few minutes (about 75 seconds with the images built, under four with a cold build), needs no secrets and no network beyond pulling images and packages, and runs every night, by hand, before a release, on every pull request and in the merge queue (`.github/workflows/e2e.yml`); it is a required check.

```sh
pnpm install && pnpm --filter outstaff... run build   # the test runs the built CLI
node e2e/run.ts                                       # builds the images, runs the loop, tears everything down
```

Needs Docker with Compose, `openssl` and `git`. `E2E_PREBUILT=1` skips the image build, `E2E_KEEP=1` leaves the stack up for a look around, `E2E_TIMEOUT_MS` bounds the run (default ten minutes). On a failure it prints the tail of the stub, office and agent logs. The office polls the stubs every second (`OUTSTAFF_POLL_INTERVAL_MS`, a testing knob below the config's minimum), and a check that something does not happen waits for two more office polls, which the office counts in its health answer, instead of a fixed time.

What is real: the `ost hire` command, the office with Postgres, the agent image, the GitHub and Its a Plan adapters talking HTTP, the agent's `ost` verbs, git cloning, committing, pushing and force-pushing over https with the credential helper, and the App JWT and installation token flow.

What is faked:

- **GitHub and the tracker** (`e2e/stubs`, one Node service). It serves the same vendor stand-ins the adapter tests use (`testing/github` and `testing/itsaplan`, see Test kits): they implement the endpoints the adapters call, keep their state in memory, serves a real bare repository over git's smart HTTP protocol, and decides mergeability with `git merge-tree`. `/_test/*` is the driver's control surface: it creates and assigns tickets, submits a human review and merges a pull request, acting as the team's humans.
- **The model** (`e2e/runtime-scripted`, a private package, never published). A runtime adapter that plays a fixed script per work item kind through the same in-process `ost` tools and the same permission policy as the real runtime. It is only in the `agent-e2e` image target.
- **Chat.** `integrations.chat` is required by the team file, so the office and agent are configured with Slack and dummy tokens; nothing talks to it.

The flow it asserts: hire, a ticket assigned to the agent, a pull request opened and the ticket moved to review, a human requesting changes (the ticket goes back to active, the agent pushes a fix, replies and resolves the thread), the human merging (the ticket is done), a second pull request that now conflicts (a follow-up item, a rebase, a force push with lease), `ost ask` to the architect (mirrored on the ticket, since no chat channel is set), a ticket the agent assigned to itself started by the office while the agent is idle, and blocked tickets going to the PM, who unblocks one (the agent resumes) and hands the others to the human with what is needed, and an answer the PM posts later on one of them wakes the agent blocked on it. Two agents run: the developer and the PM (with no chat, so it does not read the stub workspace's one inbox). The architect is not started, so the question is asserted as routed and mirrored, not answered.

Against real GitHub instead of the stub: tracked in [#195](https://github.com/outstaff-ai/outstaff/issues/195).

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

## Contributor License Agreement

Outside contributors sign a Contributor License Agreement ([CLA.md](CLA.md)) before their first pull request is merged. You keep the copyright in your work. The agreement gives the maintainers a broad licence to it, so the project can keep its licensing options open, and it gives users a patent licence for what you contribute.

To sign, post this comment on your pull request, exactly once:

> I have read the CLA Document and I hereby sign the CLA

The CLA check on the pull request then passes. Your signature is recorded and covers your future pull requests, so you will not be asked again. If you contribute as part of your job, read the section on employers in the CLA first. Comment `recheck` to run the check again. Bots such as Dependabot are exempt.

Maintainers: signatures are stored in the separate `outstaff-ai/cla-signatures` repository, written with the `CLA_SIGNATURES_TOKEN` secret (a fine-grained token with contents read/write on that repository only). The check fails on pull requests while the secret is missing.

## Code style

- TypeScript in strict mode, ESM only, and no default exports.
- Keep modules small. Put tests in a `__tests__` folder inside the folder they test, as `__tests__/*.test.ts`, and run them with vitest. Test-only fixtures and helpers go in the same `__tests__` folder; a helper the tests of several folders share goes in the `__tests__` of the folder it serves, and the others import it as `#/<folder>/__tests__/<name>.js`. `pnpm check:tests` (run in CI) fails on a test file outside a `__tests__` folder, and on a file outside one that imports vitest, except the public kits listed in `scripts/tests-layout.mjs`.
- Keep types apart from implementations. A folder's shared types go in `types.ts`, a larger contract in `<name>.types.ts`, and a file that exports functions, classes or values does not also export types (`index.ts` files re-export both). Keep each source file to one unit and under 300 lines, split along its seams. An adapter (`integrations/<port>/<vendor>`) depends only on `@outstaff/core`, `@outstaff/protocol` and shared packages: when two adapters of one vendor share code, it goes in `integrations/shared/<vendor>` (`@outstaff/integration.shared.<vendor>`), never in one adapter for the other to import. `pnpm check:files` (run in CI) enforces all three; the files it skips for the first two are listed with a reason in `scripts/file-layout.mjs`.
- Import another workspace package by its name, never by a relative path that leaves your package. Inside a package, import a file in the same folder as `./name.js` and any other as `#/path/name.js`, its path under `src` (the `imports` field of the package's `package.json`), never with `../`. Tests in `__tests__` import the code they test the same way. Each package's `exports` and `imports` have an `@outstaff/source` condition that points at its TypeScript source. Typecheck, the tests and the docs generators (`tsx --conditions=@outstaff/source`) set it, so they run on the sources without a build; the build (`tsconfig.build.json`) and Node do not, so built packages import each other's `dist`. `pnpm check:files` enforces both import rules.
- Write comments only where the why is not obvious. Match the style of the code around your change.

- **Coverage.** Integrations (`integrations/*/*`) must have 100% line, branch, function and statement coverage in every file; CI fails below it (`pnpm test:coverage`). Cover a branch with a test, or delete it if it can't run; no coverage-ignore comments.
- **Test kits.** A kit used only by its own package's tests stays in that package, in a `__tests__` folder, so the build leaves it out. A kit shared between packages is a private workspace package in `testing/<name>` (`@outstaff/testing.<name>`, `"private": true`, never packed or published): `testing/core` for shared fixtures, `testing/github` and `testing/itsaplan` for the vendor stand-ins, `testing/http` for the HTTP plumbing they share, `testing/office` and `testing/agent` for the office's and agent's kits. A vendor stand-in is one HTTP-level implementation of the vendor's API, served in process to the adapter and contract tests and over HTTP by the end-to-end stubs (its `./stand-in` export); `e2e/stubs` adds only the `/_test/*` controls, so fix the stand-in when it and the real service disagree. The stand-ins and `testing/http` are built, because the stubs image runs them with plain Node; the other kits are source only. Vendor stand-ins never ship; only the generic `@outstaff/core/contracts` and `@outstaff/core/fakes` do. A package whose tests use a kit lists it in its `devDependencies`, even when the kit depends on the package: a kit's build reads the package it tests from source (the `@outstaff/source` condition), so the order does not matter and `pnpm-workspace.yaml` sets `ignoreWorkspaceCycles` for that cycle, and `pnpm check:files` fails on any other workspace dependency cycle.
- **Fakes reuse the integration's types.** A fake or stand-in (`testing/*`, a package's `__tests__` helpers, `packages/core/src/fakes`, `e2e/stubs`) derives its shapes from the adapter's API types or the core port types, for example `type StoredIssue = ApiIssue & Required<Pick<ApiIssue, "labelIds">>`, and names them `Stored*` or `Fake*` so they don't shadow domain names. When a fake needs a field the adapter doesn't read, add it to the adapter's API type as optional instead of redefining the shape.

- **Complexity.** Functions stay at a cyclomatic complexity of 8 or less, and blocks nest at most 3 deep (`eslint/complexity`, `eslint/max-depth`). Split a function along its decisions, with guard clauses, a lookup table or small named helpers, instead of adding branches. The second `overrides` entry in `.oxlintrc.json` lists files that are still over the limit; it only ever shrinks, and nothing new is added to it. The first lists modules the event-pipeline redesign deletes.

## Reporting bugs, asking for features, and security

- Bugs and feature requests: open an issue with the matching form. Pick the adapter or role form when you want a new integration or a new role.
- Security issues: do not open a public issue. Follow [SECURITY.md](SECURITY.md).
- Conduct concerns: follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

Outstaff is licensed under the [Apache License 2.0](LICENSE). Unless you state otherwise, any contribution you submit is licensed under the same terms, as set out in section 5 of the licence. Outside contributions are also covered by the [Contributor License Agreement](CLA.md), described above.
