---
title: "0008: Hosting and secrets are out of scope"
description: Outstaff defines a container contract; clients choose where to run and how to keep secrets.
sidebar:
  order: 8
---

**Status:** accepted

## Context

Clients run containers on very different platforms: Docker Compose on one machine, Kubernetes, managed container services. They keep secrets in very different places too: env files, password managers, encrypted files in git, cloud secret managers. Supporting each one as a feature would never end, and it would weaken whatever security setup the client already has.

## Decision

- **Container contract:** Outstaff publishes the env vars, secret files, volumes, ports (office only) and health checks each container needs.
- **Secrets are files first.** Containers read each secret from `/run/secrets/outstaff/<KEY>` (or `OUTSTAFF_SECRETS_DIR`), whoever puts it there: Docker Compose `secrets:`, a mounted Kubernetes Secret, a cloud secret manager. Environment variables are a fallback for platforms that can only inject env vars.
  - Files are preferred because an agent's shell inherits its environment: a secret in an env var is one `printenv` away.
  - Outstaff removes secret keys from the environment it passes to child processes; only the runtime credential stays where the runtime binary requires it.
  - Images never contain secrets. A client image that needs one at build time uses BuildKit `--secret`, never `ARG` or `ENV`.
- **`ost setup` writes credential templates:** `.env.example` files listing every key, each with a note on where its value comes from. It derives every value it can, such as app ids, installation ids and bot ids.
- **Guides, not adapters:** Outstaff ships guides for Docker Compose, Kubernetes and common secret managers. They are written so a person, or their own assistant, can follow them.
- **Manual app creation:** creating apps on chat, code-host and tracker platforms stays manual. `ost setup` prints exact steps and manifests.

## Consequences

- No host adapters and no secret-store adapters in the framework.
- The examples under `examples/` are documentation, tested in CI, not supported products.
