---
title: "0014: What the bubblewrap sandbox needs from a container"
description: With sandbox bubblewrap, the image ships bubblewrap, the runtime checks it at start and hides the credential files, and the examples add an overlay with exactly the container settings bubblewrap needs.
sidebar:
  order: 14
---

**Status:** accepted

## Context

With `sandbox: bubblewrap` ([0013](/decisions/0013-subprocess-sandbox-opt-in/)), Claude Code 2.1.308 runs each of the agent's commands in bubblewrap. It always uses user and PID namespaces, a fresh `/proc` and `--disable-userns`, and ignores `enableWeakerNestedSandbox` in this mode. It checks only that `bwrap` exists; when bubblewrap is blocked, every command fails.

A hardened container blocks bubblewrap in four ways:

- the default seccomp profiles of Docker and containerd refuse namespace creation, mounts and `pivot_root`;
- their AppArmor profiles deny every mount;
- Ubuntu 24.04 (`kernel.apparmor_restrict_unprivileged_userns=1`) denies user namespaces to processes without a profile that grants them;
- the container's masked `/proc` stops a fresh `/proc` mount.

The sandbox also mounts the whole filesystem read-only inside, so a mounted secret file would still be readable.

## Decision

- **The agent image always ships bubblewrap and socat**, pinned, with bubblewrap not setuid. They do nothing unless the option is on.
- **The runtime checks at start.** With the option on, the adapter runs bubblewrap with Claude Code's flags before it creates the runtime, and stops the agent with one error that names the missing piece and its fix. `ost doctor` shows the same check.
- **The runtime hides Claude Code's credential files** inside the sandbox (`sandbox.credentials.files`). Other secret files stay readable, because `ost git-credential` runs inside the sandbox and needs the GitHub App keys.
- **The examples stay plain.** Optional variants change only the agents:
  - `examples/k8s-sandbox` (a kustomize overlay) and `examples/compose/compose.sandbox.yaml` (a Compose override);
  - a seccomp profile: the runtime default plus `clone` and `unshare` for user, mount, PID and network namespaces, `mount`, `umount2` and `pivot_root`;
  - an AppArmor profile: containerd's default plus `userns`, the mounts and pivots bubblewrap makes, and the write to `/proc/sys/user` behind `--disable-userns`; each added rule was checked to be needed;
  - an unmasked `/proc`, and on Kubernetes the pod's own user namespace, which Kubernetes requires for it. The overlay's namespace enforces `baseline`, because `restricted` forbids an unmasked `/proc`.

## Consequences

- Operators who turn the sandbox on install two profiles on every node that runs agents. The cluster needs Kubernetes 1.33, containerd 2.0, runc 1.2, Linux 6.3 and volumes with idmapped mounts. The deployment guides list the checks.
- Agents with the sandbox can create user namespaces in their pod. That is more kernel surface; the pod's own user namespace keeps the node's users out of reach, and bubblewrap stops commands from nesting further.
- With the sandbox on, tools that need their own user namespace inside a command (rootless Podman, Chromium's sandbox) do not run.
