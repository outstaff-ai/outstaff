---
title: Permissions
description: What agents may run, the short list of hard denies, and the boundary an operator provides around them.
---

Every tool call an agent makes is judged by its permission policy before it runs. The policy allows by default: an agent runs any program, with any arguments and any shell syntax, inside its sandbox. A short list of hard denies protects secrets, pushes and privileges. The boundary that matters sits outside the agent, and the operator provides it ([where the boundary sits](#where-the-boundary-sits)). The reasons are in [0015](/decisions/0015-allow-by-default-in-the-sandbox/).

## What an agent may do

- Run any program with any arguments: `UPDATE_SNAPSHOT=1 pnpm test`, `pnpm --filter web build`, `pnpm exec tsc`, `npx <tool>`, `sed -i`, `xargs`, `timeout`, its own node or python scripts.
- Use any shell syntax: `$VAR`, `$(...)`, subshells, pipes, here-documents such as `git commit -F - <<'EOF'`.
- Reach the network with `curl`, `wget`, `nc`, a WebSocket client in its own script, or a declared tool such as `adb` or a vendor CLI. What it reaches is decided by the deployment's network policy. [Network grants](/guides/network-grants/) name services for `ost http`, which adds a token the agent never sees.
- Read any file except credentials, including its own tool-result files and memory under `~/.claude`.
- Write its scratch and memory folders, `/tmp`, Claude Code's session folders (`~/.claude/projects`, where its memory and tool-result files live) with the edit tools, and the worktrees its profile allows ([profiles](#profiles)). Shell commands are not limited to those folders; the hard denies below still apply to them.

## Hard denies

No profile, toolset, tool declaration or team rule lifts these.

| What                               | Denied                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secrets and credential files       | The secrets folder (`OUTSTAFF_SECRETS_DIR`, by path anywhere in a command), `.env`, `.env.local`, `*.pem`, `.netrc`, `.git-credentials`, `~/.ssh/id_*`, Claude Code's `~/.claude/.credentials.json`. Read or write.                                                                                                                                                                                                                                                       |
| Printing the environment           | `env` without a command, `printenv`, `export -p`, `set` and `declare -x` without names, `ps e`, any `/proc/<pid>/environ`, and expanding a variable whose name says it is a credential (`$..._TOKEN`, `$..._API_KEY`).                                                                                                                                                                                                                                                    |
| Pushes outside the push rules      | Force push without a lease (`--force`, `-f`, `+refspec`), a push to the repository's default branch (or deleting it), `--mirror`, `--all`, a push to a URL, a push to a read-only repository or from outside the granted repositories, `--no-verify`, and `git remote` or `git config` changes that could redirect a push or skip its hooks. `--force-with-lease` to your own branch is fine.                                                                             |
| Configuration the agent runs under | Writing Claude Code's configuration (`~/.claude/settings*.json`, `CLAUDE.md`, `hooks/`, `skills/`, `agents/`, `commands/`, `plugins/`, `output-styles/`, `~/.claude.json`) and the agent's working directory (its `.claude/` project settings and the rendered skills and references), with the edit tools, redirections, or writing programs such as `cp`, `mv`, `rm`, `tee` and `sed -i`. A file there would otherwise carry instructions or hooks into later sessions. |
| Privilege tools                    | `sudo`, `doas`, `su`, `pkexec`, `runuser`, `nsenter`, `chroot`, `setpriv`, `capsh`.                                                                                                                                                                                                                                                                                                                                                                                       |

Patterns count too: `cat /proc/self/env*`, `cat *.pem` and a path pattern that could reach the secrets folder are denied, and so are recursive reads (`grep -r`, the search tool, `tar`, `cp -r`) of `/proc` or of a folder that holds the secrets folder. Process memory (`/proc/<pid>/mem`) is off limits like the environment. The policy reads through wrappers: a command inside `bash -c`, `eval`, `env`, `xargs`, `timeout`, `nohup`, `find -exec`, `$(...)`, a subshell or an expanding here-document is judged like any other.

## Default denies for infrastructure

Commands that change infrastructure are denied unless the program is allowed by a tools declaration or a team rule:

- `kubectl` `apply`, `create`, `delete`, `edit`, `patch`, `replace`, `scale`, `set`, `label`, `annotate`, `drain`, `exec`, `rollout restart` and the like;
- `helm` `install`, `upgrade`, `uninstall`, `rollback`;
- `terraform` and `tofu` `apply`, `destroy`, `import`, `taint`, `state rm`;
- `pulumi` `up`, `destroy`, `refresh`, `import`.

Declare the tool without `allow` (or with `allow: all`) and these run. The stock `infra` toolset declares terraform, kubectl and helm with read-only verbs only, so they stay denied for roles that use it.

## Narrowing

Teams can still narrow a program, or refuse some of its commands. Once an allow rule names a program, the program runs only what such rules allow; a deny rule refuses what it matches whatever allows it:

```yaml
tools:
  kubectl: { version: 1.31.3, allow: [get, describe, logs] }
  acmectl: { version: 2.4.0, allow: all, deny: [delete, wipe] }

policies:
  commands:
    allow:
      - { program: make, subcommand: [test], reason: Only the test target. }
    deny:
      - { program: acme-cli, subcommand: [prod], reason: Never touch prod. }
```

`kubectl delete pod x`, `make deploy` and `acmectl -c prod delete x` are then denied, `acmectl -c prod status` runs, and `acme-cli prod` is denied whatever else allows it. A refusal names the rule that decided it, such as `tools.acmectl.deny.delete`. Rules find the subcommand after the program's leading global options; see [tools](/guides/tools/#denying-commands) for the forms `allow` and `deny` take and for `valued_options`.

## Profiles

A role's `permissions` names its profile. Profiles no longer differ in what may run, only in what an agent may change in repositories:

| Profile    | Git                                       | Edit tools in worktrees                                           |
| ---------- | ----------------------------------------- | ----------------------------------------------------------------- |
| `readonly` | Read-only, even with a write grant.       | None.                                                             |
| `docs`     | Commits and pushes in write repositories. | Documentation files (`*.md`, `*.mdx`, `*.txt`, `*.rst`, `docs/`). |
| `code`     | Commits and pushes in write repositories. | Any file.                                                         |
| `infra`    | Commits and pushes in write repositories. | Any file.                                                         |

A chat session, which runs beside a work item, has the same tools as a work session and the rule packs of the role's profile. It has read-only git, edits no repository file, and calls only the `ost` verbs that look at the work, comment and file new work.

## Where the boundary sits

The policy reads command lines. It stops an agent from reading a secret or pushing to `main` by mistake, or because a ticket, comment or web page told it to. It does not stop a program written to get around it: a script the agent writes can do what its process can. What limits an agent is outside it, and the operator provides it:

- **A network policy.** Agents reach whatever the deployment lets them reach. Allow the code host, the tracker, the model provider, package registries and the hosts you granted, and nothing else. The [Kubernetes guide](/guides/kubernetes/#network-policy) has an example.
- **Read-only Apps for read repositories.** A clone the person may only read is fetched with the office's read-only App, which holds no write permission on any repository, so a push from it fails at the code host whatever the agent runs ([architecture](/architecture/agent/#repositories-and-credentials)).
- **Per-person identities.** Each person writes with their own App and tracker account, scoped to the team's repositories. Grant write only where the person works.
- **The subprocess sandbox.** With `sandbox: bubblewrap` ([0013](/decisions/0013-subprocess-sandbox-opt-in/), [0014](/decisions/0014-bubblewrap-sandbox-containers/)) the Claude credential is out of the commands' environment, other processes' environments and the credential files. Without it, a command can read the Claude credential: the policy denies the plain ways to print it, but it is the documented trade-off of `sandbox: off`. The other secret files stay readable to the agent's programs either way, because `ost git-credential` runs beside them, so give each person only the credentials their work needs.
- **Branch protection on the code host.** The push rules keep agents off default branches; protect them on the host too.

## Check a decision

Each tool call is logged with its decision and the rule that made it (`paths.read.deny`, `secrets.environment`, `git.push.default-branch`, `commands.narrowed`, ...). A denial goes back to the agent with its reason, so it can take another route or ask a human.
