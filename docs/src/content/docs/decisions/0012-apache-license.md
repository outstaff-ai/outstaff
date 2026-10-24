---
title: "0012: Apache License 2.0"
description: Outstaff is licensed under the Apache License 2.0.
sidebar:
  order: 12
---

**Status:** accepted

## Context

The repository started under the MIT License. It still has a single author, so the licence can change without asking anyone. That stops being true once outside contributions arrive.

The MIT License says nothing about patents, nothing about trademarks, and nothing about how contributions are licensed.

## Decision

Outstaff is licensed under the Apache License 2.0, for the reasons the licence itself gives:

- **Patent grant:** every contributor grants an explicit patent licence for their contribution. A user who sues over a patent in the software loses that licence (patent retaliation).
- **No trademark rights:** the licence states that it grants no right to use the names, trademarks or marks of the project or its contributors.
- **Contributions:** section 5 says that a contribution submitted for inclusion is licensed under the same terms, unless its author states otherwise.

The repository carries the unmodified licence text in `LICENSE` and a minimal `NOTICE`. Every `package.json` declares `"license": "Apache-2.0"`, and `pnpm run check:versions` fails when one does not. Published packages and container images ship `LICENSE` and `NOTICE`.

## Consequences

- Releases made before this change stay under the MIT License. None were published, so every release is under the Apache License 2.0.
- Contributors agree to the Apache License 2.0 terms when they contribute (see `CONTRIBUTING.md`).
- Anyone who redistributes Outstaff must keep the licence and carry the `NOTICE` file, and mark files they changed.
- The licence of third-party material, such as the avatar styles listed in the avatar adapter docs, is unchanged.
