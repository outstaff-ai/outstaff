# AGENTS.md

Guidance for coding assistants working on this repository. If you are an assistant setting outstaff up for a user in their own repository, read [Configure outstaff with an assistant](https://docs.outstaff.work/getting-started/configure-with-an-assistant/) instead. The full docs are also available as one file at <https://docs.outstaff.work/llms-full.txt>.

Outstaff is an open-source TypeScript framework for running a team of AI agents like an outsourcing agency. Status: early development, nothing is released yet.

## Repo map

| Path                           | What it is                                                                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`                | Shared types and the team config model.                                                                                                                              |
| `packages/catalog`             | Generic roles and skills, baked into container images and ejectable by clients.                                                                                      |
| `packages/cli`                 | The `outstaff` command line (alias `ost`): creates and validates the team config, hires people, sets up credentials.                                                 |
| `packages/office`              | The office: one container per team. Event intake, work state, workflow engine, scheduler, store (Postgres or SQLite).                                                |
| `packages/agent`               | `ost-agent`: one container per person. Connects out to the office and runs work items through a runtime adapter.                                                     |
| `packages/protocol`            | The agent connection protocol: zod schemas and types shared by the office and the agent.                                                                             |
| `integrations/<port>/<vendor>` | One adapter package per integration, published as `@outstaff/integration.<port>.<vendor>`. Code two adapters of a vendor share is in `integrations/shared/<vendor>`. |
| `testing/<name>`               | Private test kits shared between packages (`@outstaff/testing.<name>`): fixtures, the GitHub and Its a Plan stand-ins. Never published.                              |
| `docs/`                        | The Starlight documentation site (`@outstaff/docs`), published to GitHub Pages at docs.outstaff.work.                                                                |
| `docs/scripts/llms.mjs`        | Generates `llms.txt` and `llms-full.txt` into `docs/dist` after the docs build.                                                                                      |

Adapters (tracker, knowledge, vcs, chat, runtime, avatars) are separate packages, one per integration, each implementing a port and checked by a shared contract test kit. They live in `integrations/<port>/<vendor>` (for example `integrations/vcs/github`, `@outstaff/integration.vcs.github`). The package name does not change the `adapter:` name a team file uses (`github`, `slack`, `itsaplan`, ...).

## Commands

Requirements: Node.js 24 (pinned in `devEngines` in `package.json`) and pnpm 12 (`corepack enable`).

```sh
pnpm install
pnpm lint         # oxlint
pnpm typecheck    # tsc --noEmit in every package
pnpm test         # vitest, one project per package
pnpm build        # tsc, ESM + type declarations
pnpm docs:dev     # docs site with live reload
pnpm docs:build   # docs site + llms.txt into docs/dist
```

Run lint, typecheck, test and build before opening a PR.

## Conventions

- **Code:** TypeScript strict, ESM, no default exports, small modules, tests in a `__tests__` folder inside the folder they test (`__tests__/*.test.ts`, vitest). Comments only where the why is not obvious. Match the existing code.
- **Commits and PRs:** one commit per PR, message `<type>(<scope>): <summary>`. Large changes are split into stacked PRs, each based on the previous one. Do not push to `main` or merge your own PRs.
- **Docs ship with features:** a change that adds user-facing behaviour adds or updates a page under `docs/src/content/docs/`. The docs build validates internal links.
- **Releases:** conventional commits drive the version and release notes; all packages share one version. No changeset files.
- **Public hygiene:** this repo is public. No personal names, usernames, emails, hostnames, internal URLs, or references to other projects or companies. Examples use the synthetic team "acme". Refer to people as "human" or "trusted human"; there is no owner role.
- **Hosting and secrets are the client's choice.** Do not add host or secret-store adapters. Outstaff defines a container contract and ships guides.
- **Do not invent commands or flags** in docs. Mark anything not yet implemented as planned, with its milestone.

## Where to find the design

- Architecture overview: `docs/src/content/docs/architecture/overview.md`
- Decision records: `docs/src/content/docs/decisions/` (0001 to 0012, indexed in `index.md`). They are the source of truth. If you need to change a decision, add a new record that replaces the old one.
- Vocabulary: `docs/src/content/docs/concepts/index.md`
- Planned work is tracked in GitHub milestones M0 to M7 and "Later".
