---
title: Team config
description: What each section of .outstaff/team.yaml is for.
---

A team is described by one file, `.outstaff/team.yaml`, committed to your repository. It says who is on the team, what they may touch, which tools are connected and how work flows. Everything except `version`, `team`, `catalog`, `repos`, `people` and `integrations` is optional and has sensible defaults. Every field, with its type, default and allowed values, is in the [team.yaml reference](/reference/team-yaml/). A complete example for the synthetic team "acme" is at the top of that page.

Run `ost validate` to check the file. Problems come back with a stable code, listed in [Validation codes](/reference/validation-codes/).

## Version and team

`version` is the schema version of the file, currently `1`. The [`team`](/reference/team-yaml/#team) section names the team with a short slug and optionally describes the product it builds.

## Humans and trust

[`humans`](/reference/team-yaml/#humans) is optional. Leave it out and trusted humans are the people with write access to your repositories and the full members of your chat workspace. List humans when you want trust narrowed to named people, which is recommended for large workspaces and open-source repositories. Each entry gives a name and the human's identity on each system (code host, tracker, chat, email). Anything said by someone who is not trusted is treated as data, never as an instruction. `ost validate` warns with `trust.default` when the default applies.

## Catalog

[`catalog`](/reference/team-yaml/#catalog) pins the version of the catalog of roles and skills the team uses, and can point to a folder of your own ejected roles.

## Repos

[`repos`](/reference/team-yaml/#repos) lists the repositories the team works in. Each has a name, a URL and a kind (`primary`, `baseline`, `infra` or `other`). At most one repository is primary.

## People

[`people`](/reference/team-yaml/#people) are the agents. Each has a handle, a display name, a role from the catalog, optional extra roles to combine with it (`extends`), and a `repos` map of grants. A grant key is a repository name, `kind:<kind>` to cover every repository of a kind, or `*` for all of them, and the value is `read` or `write`. A person with no grants can do nothing, which `ost validate` reports as `people.no_repos`.

## Integrations

[`integrations`](/reference/team-yaml/#integrations) chooses an adapter for each port: chat, vcs, runtime, tracker, knowledge and avatars. Each entry names the `adapter` and passes the options that adapter defines, which the adapter validates. Which agent capabilities work depends on what the chosen adapters support; missing ones are reported as warnings such as `capability.missing`.

## Email

[`email`](/reference/team-yaml/#email) sets a pattern for the address of each agent. It must contain `{handle}`.

## Office

[`office`](/reference/team-yaml/#office) controls how the office learns about changes: by polling every so many seconds, or by webhooks.

## Workflow

[`workflow`](/reference/team-yaml/#workflow) picks a preset, maps the canonical statuses (`backlog`, `ready`, `active`, `review`, `blocked`, `done`, `canceled`) to the names in your tracker, and adds or overrides rules. A rule reacts to an event, checks a condition and performs actions such as moving a ticket, assigning it or commenting. A rule with the same id as a preset rule replaces it, and `{ id, disabled: true }` removes it.

## Policies

[`policies`](/reference/team-yaml/#policies) holds team-wide guardrails: a loop guard that limits runs triggered by agents and automation (humans are never limited), usage thresholds that defer scheduled work and then pause automatic work as the LLM usage limit nears, the style of chat messages, and the commands agents may run.
