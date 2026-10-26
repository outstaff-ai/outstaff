<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/logo-dark.svg">
    <img src="assets/brand/logo.svg" alt="outstaff" width="360">
  </picture>
</p>

# Outstaff

Hire a team of AI agents the way you would staff a project with an agency: a project manager, product, architect, designer, developers, reviewer and devops. Each one has a name, a role and their own accounts. They work in your tracker, chat with you in your messenger, and open pull requests in your repositories.

Outstaff is the agency:

- **A catalog of roles and skills**, shipped as ready-to-run container images. Use it as is, or eject and customize it.
- **A team config** (`.outstaff/team.yaml`) in your repository: who is on the team, which repos they can read or write, and which tools you use.
- **An office**: one container that watches your repos and tracker, schedules work for each agent, routes questions between agents, and keeps every ticket and pull request moving.
- **Adapters** for your tools: issue trackers, docs, chat, code hosting and the LLM runtime.

You run the containers wherever you like (Docker Compose, Kubernetes, anything that runs containers), with secrets from wherever you keep them.

> Status: early development. Nothing is released yet. Follow the [milestones](https://github.com/outstaff-ai/outstaff/milestones) for progress.

## Development

Requirements: pnpm 12. The Node.js version is pinned in `package.json` (`devEngines.runtime`), and pnpm downloads it on install if it is missing.

```sh
pnpm install
pnpm lint        # oxlint
pnpm typecheck   # TypeScript 7, no emit, in every package
pnpm test        # vitest, one project per package
pnpm build       # TypeScript 7: compiled ESM, declarations and source maps in each package's dist/
```

Packages live in `packages/*`: `core`, `catalog`, `cli` (published as `outstaff`), `agent` and `office`. Adapters live in `integrations/<port>/<vendor>` and are published as `@outstaff/integration.<port>.<vendor>`, for example `integrations/tracker/itsaplan` as `@outstaff/integration.tracker.itsaplan`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for branching, commit and PR rules.

## Sponsors

Outstaff is open source under the Apache License 2.0 and built in the open. Sponsorship pays for maintenance, releases and the container images.

[Sponsor Outstaff](https://github.com/sponsors/outstaff-ai) on GitHub, one time or monthly. Thank you to everyone who does:

<a href="https://github.com/sponsors/outstaff-ai"><img src="https://docs.outstaff.work/sponsors.svg" alt="Sponsors of Outstaff"></a>

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE).
