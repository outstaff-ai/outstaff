---
title: GitHub CLI (vcs)
description: How agents run gh with a short-lived token per call, and which gh commands they may run.
---

Agents can run GitHub's own CLI, `gh`, for work that has no `ost` verb: re-running a flaky workflow run, reading a run's logs and artefacts, dispatching a workflow, generating an Actions lockfile with a declared extension (`gh actions-lock`) or a read-only query of the REST API. The boundary is the person's GitHub App and its permissions, and the network, not a verb per task.

## How gh gets a token

The `github` vcs adapter declares `gh` as the code host's CLI. A GitLab adapter would declare `glab` the same way; the agent itself does not know which CLI it is.

1. At start the agent writes a wrapper named `gh` into `~/.local/share/outstaff/bin` and puts that directory first on its PATH, ahead of the tools' shims. The wrapper holds no secret: it runs `ost host-cli -- "$@"`.
2. `ost host-cli` finds the team repository the call acts on: the one `-R`/`--repo` names, else the repository of the working directory (its `origin`). A repository the team does not list, or one the person has no grant on, is refused.
3. It asks the adapter for a short-lived token for that one repository, the same way [git's credential helper](/architecture/agent/#repositories-and-credentials) does: the person's own App for a write grant, the read-only office App for a read grant, and read for the `readonly` profile whatever the grant. The token asks GitHub for no permissions, so it carries what the App is granted there, and no more.
4. It runs the real `gh` with the token in that process's environment only (`GH_TOKEN`, or `GH_ENTERPRISE_TOKEN` and `GH_HOST` on GitHub Enterprise Server, plus `GH_REPO`). Every call gets a fresh token; nothing is written to disk or left in the agent's environment.

The App's permissions are the hard limit: a `gh` command the App may not do fails at GitHub, whatever the rules below allow. Re-running, cancelling and dispatching workflow runs need **Actions: read and write** on the App. `ost setup` asks for it for roles with the `vcs.ciRuns` capability (the stock developer, architect and devops), and `ost doctor` fails when such a person's App lacks it. Other roles keep Actions read-only: those commands fail at GitHub with a 403, and reading runs still works. No role gets Checks: write.

## Install it

Install `gh` through [`tools`](/guides/tools/), at the version the adapter suggests (an agent without it gets this hint when it runs `gh`):

```yaml
tools:
  gh: { version: 2.103.3 }
```

Leave out `allow`: the adapter's rules below narrow `gh`, and a `tools` entry without `allow` (or with `allow: all`) does not widen them. Declare it per person (`people[].tools`) instead to give it only to some people.

## What agents may run

| Command                                                                                   | Decision                                                                                       |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `gh run view`, `list`, `watch`, `download`                                                | allowed                                                                                        |
| `gh run rerun`, `gh run cancel`, `gh workflow run`                                        | allowed; the App needs Actions: write                                                          |
| `gh workflow view`, `gh workflow list`                                                    | allowed                                                                                        |
| `gh pr view`, `checks`, `diff`, `list`                                                    | allowed                                                                                        |
| a [declared extension](#extensions)'s command, such as `gh actions-lock`                  | allowed                                                                                        |
| `gh extension install`, `upgrade`, `remove` (also as `gh ext` and `gh extensions`)        | denied: extensions are declared in `team.yaml`                                                 |
| `gh api` with GET (the default, or `-X GET` with fields as query parameters)              | allowed                                                                                        |
| `gh pr merge`                                                                             | denied: merging goes through [`ost pr merge`](/reference/agent-verbs/), which checks the rules |
| `gh pr review --approve`                                                                  | denied                                                                                         |
| `gh repo delete`, `gh repo edit`, `gh secret`                                             | denied                                                                                         |
| `gh api` with another method, with fields (`-f`, `-F`, `--input`) and no `-X`, `graphql`  | denied: `gh api` is read-only                                                                  |
| anything else, for example `gh pr create`, `gh release create` or an undeclared extension | refused: pull request work goes through `ost pr`                                               |

Denied commands stay denied whatever a team rule or a tool declaration allows. A team that wants agents to run more of `gh` adds allow rules under [`policies.commands`](/guides/permissions/#narrowing); the App's permissions still decide what GitHub accepts.

## Extensions

`gh` extensions, such as `gh actions-lock` from `github/gh-actions-lock`, are declared on the `gh` tool entry, each pinned to a release tag or a full commit id:

```yaml
tools:
  gh:
    version: 2.103.3
    extensions: [github/gh-actions-lock@v1.2.0]
```

The adapter declares how `gh` takes them: an extension is a repository named `gh-<command>`, installed with `gh extension install <owner>/<repository> --pin <ref>` into gh's data directory (`$XDG_DATA_HOME/gh/extensions`, else `~/.local/share/gh/extensions`). At start the agent installs each one there through the same per-call token as any `gh` run, minted for the extension's repository when the team lists it and the person has a grant on it, else for the first team repository the person has a grant on. The token carries what the person's App may read, so a public extension or one in a repository the App can read installs; the repository must be on the team's code host. The home volume keeps it across restarts; a changed ref installs it again, and an extension that is no longer declared is removed.

Agents run a declared extension's command and nothing else of it: `gh extension install`, `upgrade` and `remove` are denied whatever a team rule allows, and an extension that is not declared is refused like any other unlisted command. `allow` entries on the `gh` tool that start with the extension's command (`allow: ["actions-lock check"]`) narrow it. An extension that fails to install, for example a tag with no release, is reported by `ost doctor` with gh's error; the agent starts without it. See [Tools](/guides/tools/#extensions-of-the-code-hosts-cli).
