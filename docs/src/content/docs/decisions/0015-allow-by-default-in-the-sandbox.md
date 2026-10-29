---
title: "0015: Allow by default inside the sandbox"
description: The permission policy stops listing safe commands. Agents run any program; a short list of hard denies protects secrets, pushes, privileges and devices.
sidebar:
  order: 15
---

**Status:** accepted. Replaces the command and network parts of [0006](/decisions/0006-runtime-neutral-permissions/). The device parts (the `adb` and `fastboot` hard denies and `ost adb`) are replaced by [0017](/decisions/0017-no-bespoke-protocol-verbs/).

## Context

[0006](/decisions/0006-runtime-neutral-permissions/) built the policy as an allow-list: a program ran only when a profile, toolset or team rule listed it, raw network tools were denied, and the shell parser refused anything it could not follow. A three-day audit of a live team found about 150 denials, almost all of ordinary work:

- `pnpm format`, `pnpm --filter`, `pnpm exec` and `npx`, because only a few first subcommands were listed;
- env-prefixed commands (`SNAPSHOT=1 pnpm test`), heredocs, `$VAR`, subshells, `xargs`, `sed -i`, `timeout` and `awk`;
- reading the agent's own tool-result spill files under `~/.claude`, and writing its own memory there;
- a WebSocket or `curl` to a service the person was granted, so agents asked humans to run scripts;
- chat sessions with fewer tools than work sessions, and roles without node or python.

Almost none were risky. The limits that matter already sit outside the agent: the subprocess sandbox, the deployment's network policy, per-person code-host and tracker identities, and read-only Apps for read repositories. An allow-list of commands adds friction without adding a boundary, since any allowed interpreter can do what a denied command does.

## Decision

- **Any program, any arguments, any shell syntax.** The policy allows what no rule denies. That includes `curl`, `wget`, `nc`, WebSocket clients and raw `adb`: what the network reaches is the deployment's network policy's job. The agent reads anything but credentials, and writes its scratch, memory and tmp folders and Claude Code's session folders (`~/.claude/projects`); the edit tools still write only where the profile allows (worktrees of write repos, docs files for the `docs` profile).
- **A short list of hard denies**, which no rule can lift:
  - reading the secrets folder or credential files (`.env`, `*.pem`, `.netrc`, `.git-credentials`, ssh keys, Claude Code's `.credentials.json`) and printing the environment (`env`, `printenv`, `export -p`, `set`, `ps e`, `/proc/*/environ`, and expanding a variable whose name says it is a credential);
  - git pushes outside the push rules: a force push without a lease, a push to a default branch, a push to a read-only repository or from outside the granted repositories, and the config changes that could redirect a push;
  - writing Claude Code's configuration under `~/.claude` (settings, `CLAUDE.md`, hooks, skills, agents, commands, plugins) or the agent's working directory (project settings, rendered skills and references), so that no file becomes a way to persist instructions;
  - `sudo` and other privilege tools;
  - destructive `adb` and `fastboot` commands: factory reset and wipes, recovery and bootloader reboots, `rm -r` of the device's data roots, removing system packages.
- **Default denies for infrastructure writes.** Mutating `kubectl`, `helm`, `terraform`, `tofu` and `pulumi` commands are denied unless a tools declaration or team rule allows the program.
- **Narrowing instead of listing.** A tool declaration's `allow` is optional and defaults to all. When an allow rule names a program (a tool's verb list, a toolset rule, `policies.commands.allow`), the program runs only what such rules allow. Deny rules win as before.
- **The shell parser follows instead of refusing.** Heredocs, substitutions, subshells, wrappers (`bash -c`, `env`, `xargs`, `timeout`, `find -exec`) are read, and the commands inside them are judged like any other.
- **The base toolset installs python** for the roles that do not build software (designer, PM, product, reviewer); node comes with the image.
- **Chat sessions get the tools of a work session** and the rule packs of the role's profile. They keep read-only git, no repository edits and their short list of `ost` verbs.
- **`ost http` and `ost adb` stay** as conveniences: token injection, device selection, pairing and ports. They are no longer the only route.

## Consequences

- The policy is a guard against mistakes and against an agent being talked into reading or pushing what it should not, not a sandbox. A program the agent writes can do what its process can; the secret files `ost git-credential` reads stay readable to it. Operators provide the boundary: the network policy, read-only Apps for read repositories, per-person identities, and `sandbox: bubblewrap` where the cluster allows it ([0013](/decisions/0013-subprocess-sandbox-opt-in/)).
- The runtime hook sees `allow` or `deny`; nothing is left for a human to approve.
- `network.raw_http` is gone: `curl` needs no switch.
