---
title: Runtimes
description: Choose the LLM runtime and model for the whole team and for each person, what is checked per person, how usage limits follow the credential, and which runtimes an image carries.
---

A runtime adapter runs an agent's sessions: it talks to the model, enforces the agent's permission policy and reports its usage limits. The team names a default runtime, and each person can run on a runtime and a model of their own, for example an architect on one runtime and a developer on another.

Outstaff ships one runtime adapter today, `claude-agent-sdk` (the Claude Agent SDK, [0009](/decisions/0009-agent-sdk-runtime/)). Choosing a runtime per person already lets two people on the same adapter use different options, such as a different sandbox setting; a second adapter becomes a choice when one ships.

## The team's runtime and a person's own

`integrations.runtime` is the default. A person without a `runtime` of their own runs on it:

```yaml
people:
  - handle: mira
    name: Mira Okafor
    role: architect
    model: opus
  - handle: kofi
    name: Kofi Mensah
    role: devops
    model: sonnet
    runtime:
      adapter: claude-agent-sdk
      sandbox: bubblewrap
integrations:
  runtime:
    adapter: claude-agent-sdk
```

- `people[].runtime` has the same shape as `integrations.runtime`: `adapter` and that adapter's options. It replaces the team's runtime for that person as a whole; options are not merged, so repeat any team option the person should keep. `ost validate` checks the options against the adapter's own schema and reports a wrong one at the person's line (`integrations.invalid_options`).
- `people[].model` is the model the person runs on, and every person needs one: there is no default model, neither in the role nor in the runtime adapter. `ost validate` names a person without one (`people.missing_model`). The model is independent of where the runtime comes from: people on the same runtime can run on different models.
- `ost team` shows the runtime and the model of each person.

The agent logs the choice at start, for example `runtime selected {"person":"kofi","runtime":"claude-agent-sdk","model":"sonnet"}`.

## What is checked per person

Each runtime adapter declares its capabilities. Outstaff checks every person against the runtime they run on, not against the team's:

| Capability            | Needed for                                                                                                     | When the person's runtime lacks it                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime.permissions` | Compiling and enforcing the person's permission policy ([0006](/decisions/0006-runtime-neutral-permissions/)). | An error (`people.runtime_missing_capability`), and the agent refuses to start. Every agent runs under its policy.                                                |
| `design.canvas`       | The [Design canvas](/guides/design-canvas/), for roles that declare it.                                        | An error when the role lists it under `needs`, a warning (`capability.optional_missing`) under `optional_needs`. The agent leaves the canvas off for that person. |
| `runtime.usage`       | Reporting usage windows for the [usage policy](/architecture/office/#usage-policy).                            | A warning (`people.runtime_without_usage`): the person never reports, so their work is not deferred or paused near a limit.                                       |
| `runtime.sessions`    | Resuming a work item's session in a later round ([0010](/decisions/0010-context-per-work-item/)).              | An error when a role needs it.                                                                                                                                    |

The messages name the person and their runtime, for example `Role "designer" can use design.canvas, which runtime "<adapter>" of leo does not provide.` The adapter's command rules (its rule pack), its working-file layout and `ost setup` and `ost doctor` for a person also follow that person's runtime, so a person on one runtime is never asked for another runtime's credentials.

`ost validate` checks the adapters this build ships. A runtime it does not know, for example one only a custom image carries, is accepted as written and not checked; the agent checks it when it starts.

## Credentials and usage limits

Each agent container signs in to its runtime with its own credential ([0008](/decisions/0008-hosting-and-secrets-out-of-scope/)), so each person counts against their own limits. People who share one subscription share its limits; list them in `policies.usage.shared`:

```yaml
policies:
  usage:
    shared:
      - [sam, noor]
```

A group stands for one credential, and a credential belongs to one runtime, so every member of a group must run on the same runtime adapter; `ost validate` rejects a group that mixes them (`policies.usage_shared_mixed_runtime`). The office applies a usage report from one member to the members on the reporter's runtime only. People on different runtimes are never in one group, and a person in no group counts alone.

## Which runtimes an image carries

A runtime adapter is code, so it has to be in the agent image the person runs in. The published `agent` image carries `claude-agent-sdk`. The label `work.outstaff.runtimes` lists an image's runtimes, and `ost-agent --runtimes` prints them; see [Container images](/guides/images/#runtimes-an-image-carries). An agent whose person names a runtime its image does not carry stops at start:

```text
kofi runs on the runtime adapter "<adapter>", which is not installed in this build (it carries: claude-agent-sdk).
```

Give that person an image that carries their runtime, or change their `runtime`.
