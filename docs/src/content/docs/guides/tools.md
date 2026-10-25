---
title: Tools
description: Declare the tools your agents need in team.yaml or a toolset, pin their versions, and say exactly which commands they may run.
---

One image cannot carry every tool a team needs, and Outstaff keeps no list of tools. Instead you declare the tools by name and exact version, and each agent installs them with [mise](https://mise.jdx.dev/) when it starts. The declaration also says which commands the agent may run. The two are one thing on purpose: a tool you install but do not allow does nothing.

## Declare a tool

Add `tools:` to `team.yaml` for every agent, or under a person for one agent:

```yaml
tools:
  go: { version: 1.23.4, allow: all }
  kubectl: { version: 1.31.3, allow: [get, describe, logs] }
  their-cli:
    source: "github:vendor/their-cli"
    version: 0.9.1
    allow:
      - subcommand: [status]
        reason: Read-only.

people:
  - handle: sam
    name: Sam Duarte
    role: developer
    tools:
      terraform: { version: 1.9.8, allow: [init, validate, plan] }
```

The key is the program name the agent runs. The stock catalog toolsets declare tools the same way: the `infra` toolset installs terraform, kubectl and helm with read-only verbs. A role's toolset is the base, `tools:` in `team.yaml` replaces a tool of the same name from it, and a person's `tools:` replaces the team's. The winning declaration replaces the others completely, `allow` included, so overriding a version also decides the verbs.

## Versions

Versions are exact: `1.23.4`, not `1`, `^1.2`, `1.x` or `latest`. A reproducible team is worth more than an automatic upgrade, and an upgrade is one reviewed line. The validator rejects anything else with `tools.invalid_version`. Write the full version the tool publishes; mise treats a short version like `1.23` as a prefix and picks a release for you.

## Sources

Without `source`, mise looks the name up in its registry. Set `source` to a mise backend and name when the tool is not there, or to pick the backend yourself:

| Source                         | Installs                                  |
| ------------------------------ | ----------------------------------------- |
| `github:vendor/their-cli`      | A GitHub release, with asset matching.    |
| `npm:their-cli`, `pipx:name`   | A package from a package manager.         |
| `cargo:name`, `go:example.com` | A package built from a language registry. |

The `npm`, `pipx`, `cargo` and `go` backends need that package manager on the agent, which usually means declaring it as a tool first. Two tools cannot share a source (`tools.duplicate`).

`ubi:vendor/their-cli` also works but mise has deprecated that backend, so prefer `github:`.

## The stock toolsets

The agent image carries only Node, git and mise. The `code` toolset installs pnpm, yarn, python and go at pinned versions and allows the verbs it always did (pnpm and yarn: `install`, `ci`, `test`, `run`, `lint`, `build`, `typecheck`; python and go: any arguments). The `infra` toolset installs terraform, kubectl and helm with read-only verbs. Native build toolchains (`make`, `g++`, a C library for packages that compile) are not provided. A team that needs them builds a prebuilt image or installs them from a tool source; the `code` toolset still allows `make` if it is on the `PATH`.

## Permissions

The default is nothing. `allow` is the only thing that lets the agent run a tool:

- `all` allows the program with any arguments.
- A list of words, such as `[get, describe, logs]`, allows those first subcommands: `kubectl get pods` runs, `kubectl delete pod x` still asks.
- Structured rules take the same fields as `policies.commands` (`subcommand`, `args`, `reason`, `requires_repo`). `program` may be left out; when given it must be the tool's own name.
- `[]` installs the tool and allows nothing.

Outstaff's built-in denies still win over everything here: raw network tools, shell wrappers such as `sudo` and `env`, and git, which repository grants govern. Declaring `curl` with `allow: all` does not make it runnable.

## What happens at start

The agent works out the person's effective tool list, writes `mise.toml` to `$HOME/.config/outstaff/tools/`, and runs mise. The first start locks the versions (`mise lock`, which records checksums in `mise.lock`) and installs them. Later starts compare a hash of the list and the lockfile and do nothing when it has not changed. A changed version refreshes the lock and installs the new version. If the lockfile is there for the same list but the hash is lost, the agent installs from it with `mise install --locked`. The mise shims are put on the `PATH` of the programs the runtime starts.

Installing a version does not make it the active one, so the agent also writes the global mise config, `$HOME/.config/mise/config.toml`, listing every declared tool at its version (set `MISE_GLOBAL_CONFIG_FILE` to keep it elsewhere, for example on the data volume). It does this on every start. A shim such as `pnpm` then resolves in any directory. A repository's own mise config or `.tool-versions` still wins inside that repository.

Last, the agent asks mise, from the home directory, which version of each tool is active and whether it is installed.

Installing costs time on the first start: allow for it in the startup probe or grace period ([container contract](/reference/container-contract/#resources)). Keep the mise data and cache directories on the home volume so a replaced container does not install again.

If a tool cannot be installed, or is installed but does not resolve, the agent does not start. The error names the tool and version and is written to the startup log, so the problem shows at start and not at the first command. Fix the declaration or the egress and restart. Nothing is recorded for a failed install, so the next start tries again. `ost doctor <handle>` runs the same check: inside the agent container a tool that does not resolve is a failure; elsewhere it is a warning, or a note that mise is not installed there.

## Repositories that pin their own package manager

A repository can ask for its own pnpm: `packageManager` in `package.json`, or `devEngines.packageManager` with `onFail: "download"`. The pnpm the toolset installs starts, sees the request and switches itself to that version, so the declared version is only the starting point. The same goes for yarn and `packageManager`. This needs egress to the npm registry on first use of each version.

## Egress

Installing needs outbound HTTPS to the tool sources: mise's registry and release hosts, `github.com` and `api.github.com` for `github:` (and the older `ubi:`), and the package registries of the backends you use. Only the first start and a version change need them, so you can leave them blocked afterwards. See [egress](/reference/container-contract/#egress).

## Prebuilt images instead

If you would rather install nothing at start, or cannot allow the egress, build your own image from the agent image and install the tools into its mise data directory (`mise install` at build time with the same versions). Keep declaring them in `team.yaml` so the permissions apply; the start then finds everything installed and needs no egress. Keep the versions in the declaration and in the image the same, or the start installs the declared ones.

## Verified with

The install flow was checked against mise 2026.10.18 (the version the agent image pins) in a container running as a non-root user with a read-only root filesystem and a writable home: `mise lock`, `mise install` and `mise install --locked` on a project `mise.toml` with `lockfile = true`, then a version change. Notes from that run: `mise lock` exits successfully even for a version that does not exist, and the following `mise install` is what fails and names it. `--locked` refuses a list that changed since the lock was written, which is why Outstaff locks again whenever the list changed.
