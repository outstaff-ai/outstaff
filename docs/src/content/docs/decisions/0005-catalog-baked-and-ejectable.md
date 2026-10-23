---
title: "0005: Catalog baked in, ejectable"
description: Roles and skills ship inside the images; clients eject what they want to change.
sidebar:
  order: 5
---

**Status:** accepted

## Context

Most teams want working roles out of the box. Some need to change a skill, or replace it completely. Copying the whole catalog into every client repository makes upgrades painful. Overriding fragments of text is fragile.

## Decision

- **Stock:** the catalog is baked into the agent images. At start, the agent renders its working files from the catalog plus values from the team config: team name, repositories, people by role, link templates. The client repository holds no skill files.
- **Eject:** `ost eject <role|skill|reference|--all>` copies files to `.outstaff/catalog/` in the client repository and records the catalog version each file came from.
  - Ejected files win over stock files with the same path.
  - The client builds their own image `FROM` the outstaff image and runs `ost build`, which validates and renders the ejected content.
- **Custom roles:** a client can add roles the stock catalog doesn't have, in `.outstaff/catalog/roles/<role>/` (`role.yaml`, `SKILL.md`). They merge with the stock roles. A custom role can `extends` stock roles to reuse their skills. `ost role new <name> [--from <role>]` scaffolds one. A role that needs tools beyond the stock toolsets runs on the client's own image, built `FROM` the outstaff image.
- **Upgrade:** `ost upgrade` merges each ejected file three ways: its recorded base, the new catalog and the client's copy. Conflicts appear as ordinary conflict markers. `ost diff` shows what an ejected file changed.
- **Placeholders are strict.** Rendering fails on an unknown placeholder, so typos never reach an agent.

## Consequences

- Teams that don't customize never rebuild images. Configuration changes only need a restart.
- Ejected teams own their image build.
- Validation checks role names against the merged catalog (stock and client), so custom roles are first-class.
- Roles proven as custom roles can graduate into the stock catalog.
- Catalog files carry no client-specific names, people or hosts.
