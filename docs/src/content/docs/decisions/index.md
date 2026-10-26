---
title: Decisions
description: Architecture decision records.
sidebar:
  order: 0
---

Each record explains one decision: the context, what was decided, and what follows from it. Records are not rewritten when a decision changes. A new record replaces the old one and links back to it.

| #                                                         | Decision                                                                      |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [0001](/decisions/0001-agency-model/)                     | The agency model: catalog, team, people, office                               |
| [0002](/decisions/0002-ports-and-adapters/)               | Ports and adapters, one package per adapter                                   |
| [0003](/decisions/0003-office-schedules-work/)            | The office is the only scheduler; agents connect out; the tracker is optional |
| [0004](/decisions/0004-trust-model/)                      | Trusted humans, with no owner role                                            |
| [0005](/decisions/0005-catalog-baked-and-ejectable/)      | The catalog is baked into images and can be ejected                           |
| [0006](/decisions/0006-runtime-neutral-permissions/)      | A runtime-neutral permission policy                                           |
| [0007](/decisions/0007-store-postgres-and-sqlite/)        | The office store supports Postgres and SQLite                                 |
| [0008](/decisions/0008-hosting-and-secrets-out-of-scope/) | Hosting and secret storage are out of scope                                   |
| [0009](/decisions/0009-agent-sdk-runtime/)                | The Claude Agent SDK is the primary runtime; the CLI is a fallback            |
| [0010](/decisions/0010-context-per-work-item/)            | Each work item has its own context                                            |
| [0011](/decisions/0011-configurable-workflow/)            | Workflows are configured, not hard-coded                                      |
| [0012](/decisions/0012-apache-license/)                   | The project is licensed under the Apache License 2.0                          |
| [0013](/decisions/0013-subprocess-sandbox-opt-in/)        | The subprocess sandbox is opt-in                                              |
| [0014](/decisions/0014-bubblewrap-sandbox-containers/)    | What the bubblewrap sandbox needs from a container                            |
| [0015](/decisions/0015-allow-by-default-in-the-sandbox/)  | Allow by default inside the sandbox, with a short list of hard denies         |
