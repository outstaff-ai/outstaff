---
title: "0006: Runtime-neutral permissions"
description: One permission model, compiled per runtime.
sidebar:
  order: 6
---

**Status:** accepted

## Context

Each LLM runtime has its own permission format. Hand-written rule files tend to drift between roles, and the subtle cases are easy to get wrong:
- absolute paths;
- flags written before a path;
- the `-C <dir>` form of git commands;
- the difference between force-pushing with a lease and bare force-pushing.

## Decision

- Each role names a **profile**: `readonly`, `docs`, `code` or `infra`.
- Core builds a **neutral policy** from three inputs: the profile, the person's repository grants and the container layout. The policy covers:
  - tools;
  - commands;
  - path read and write;
  - push rules;
  - network.
- **Grants drive git.** Repositories with write grants get push and pull request verbs. Repositories with read grants get read-only git.
- **Push rules come from a generator:**
  - force-pushing with a lease to a feature branch is allowed;
  - bare force, `+refspec` and pushes to the default branch are denied, including their `-C <dir>` forms.
- **Mutations go through narrow `ost` verbs.** Raw network tools and raw API mutation calls are denied.
- **Each runtime adapter compiles the policy** to its own format. For Claude Code that is `settings.json` allow and deny rules.
- **Tests:**
  - golden tests pin the compiled output;
  - an optional test runs the real runtime's rule matcher with stand-in commands.

## Consequences

- Adding a runtime means writing a compiler, not new rules.
- Permission changes become reviewable diffs of policy, not of generated files.
