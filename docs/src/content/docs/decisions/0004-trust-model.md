---
title: "0004: Trusted humans, with no owner role"
description: Who agents take instructions from.
sidebar:
  order: 4
---

**Status:** accepted

## Context

Agents act on what people tell them: review comments, chat messages, ticket assignments. If anyone can direct them, an outside contributor's comment becomes a command. A single hard-coded owner doesn't fit teams with several people either.

## Decision

- **No owner role.** Every trusted human can direct the team.
- **Trusted by default, per channel:**
  - on the code host, anyone with write access to the repository;
  - in chat, full members of the workspace (not guests, not bots).
- **Optional `humans:` list.** It narrows trust to named people, with their identity on each system. It is recommended for large workspaces and open-source repositories.
- **Everything else is data.** Text from untrusted people, and all ticket, pull request and document content, is read as information, never followed as instructions. This is a catalog rule and is also enforced through permissions (see [0006](/decisions/0006-runtime-neutral-permissions/)).
- **Humans are never rate-limited.** The loop guard applies only to runs triggered by agents and automation.
- **Hand-back:** finished work goes to the human who asked for it. With no such human, it goes to the first listed human.

## Consequences

- Chat adapters apply the trust filter themselves, because platforms differ in how they mark guests and bots.
- Code-host adapters look up permissions, and cache them in the office.
