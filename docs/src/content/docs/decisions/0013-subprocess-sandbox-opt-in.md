---
title: "0013: The subprocess sandbox is opt-in"
description: Claude Code's credential scrub and bubblewrap sandbox are a runtime option, off by default, because they need containers that allow user namespaces.
sidebar:
  order: 13
---

**Status:** accepted

## Context

An agent runs shell commands, and Claude Code, which runs them, holds the Claude credential in its environment. Setting `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` makes Claude Code remove credentials from the environment of commands, hooks and MCP servers. On Linux it also runs each command in a bubblewrap sandbox with its own user and PID namespaces, so a command cannot read the credential from `/proc/<pid>/environ` of Claude Code.

The runtime used to set the variable always. Since Claude Code 2.1.308 (Agent SDK 0.3.308), Claude Code refuses to start in that mode without bubblewrap, so no agent ran in the published image. Adding bubblewrap is not enough: a hardened container's seccomp and AppArmor profiles and its masked `/proc` block it, and allowing it takes node-level profiles and a pod with its own user namespace. Managed clusters often do not allow that. Claude Code itself leaves the scrub off by default.

## Decision

- **A runtime option, `sandbox: off | bubblewrap`, default `off`.**
  - `off`: the runtime does not set the variable and drops an inherited one. The agent's commands can read the Claude credential, the same as with Claude Code on a developer's machine. Every other adapter's secret is still removed from their environment.
  - `bubblewrap`: the runtime sets the variable. The agent stops at start, with one error, when bubblewrap is missing.
- **The trade-off is documented** in SECURITY.md and the adapter's README, with the mitigations for `off`: trusted humans direct work, network tools can be denied in policies, a dedicated key with a spend limit, rotation if it leaks.

## Consequences

- Agents run on any cluster again, with the same exposure as Claude Code on a laptop.
- Teams that can allow user namespaces turn the sandbox on. Shipping bubblewrap in the image, the container profiles and a fuller start-up check are tracked separately.
