# @outstaff/catalog

The catalog of agent roles and skills that ship with Outstaff, as plain content that can be used as is or ejected and customized. Early development; nothing is released yet.

## Format

```
roles/<role>/role.yaml   name, title, summary, toolset (base|code|infra),
                         permissions (readonly|docs|code|infra), needs,
                         optional_needs, default_model, modes[{name, when}],
                         extends[], files {skill: SKILL.md}
roles/<role>/SKILL.md    the role's skill (the renderer adds name + description front matter; a description in the file wins over the role summary)
process/*.md  references/*.md  templates/*.md
profiles/                reserved
```

The catalog version is the `version` of this package. Markdown files may use team values:

- `{{ team.name }}`, `{{ repos.primary.name }}`, `{{ links.issue }}`
- `{{#if path}}..{{else}}..{{/if}}`, `{{#unless path}}..{{/unless}}`, `{{#each path}}{{this.field}} {{@index}}{{/each}}`
- `\{{` prints a literal `{{`

Which values a file sees depends on its kind:

Every file gets the same context: `team`, `repos`, `people` (and `people.byRole`), `integrations`, `links` and `policies`. Beyond the basics:

- `people.list[]` and `people.byRole.<role>[]` entries have `handle`, `name`, `pronouns`, `role`, `role_title`, `role_summary` (from the role's `role.yaml`, empty if the role is not in the catalog) and `model`.
- `people.byRole` has a key, possibly an empty list, for every role in the catalog in use (stock plus ejected). A role that is not in the catalog is still an error.
- `roles[]` lists every catalog role with `name`, `title`, `summary` and `people` (the same list as `people.byRole.<name>`).
- `humans.list[]` has the `name` of each trusted human, `humans.has` says whether there are any, and `humans.default_trust` is true when `team.yaml` has no `humans:` list (trust then follows repo write access and workspace membership). Identities and ids are never in the context.

There is no `person`: a skill describes how a role works, so it reads the same for everyone in that role. Who the agent is (name, handle, role, team) is built from data by the runtime when the agent starts, not templated here. Using `{{ person.* }}` anywhere is an error.

Rendering is strict: an unknown path (also in `#if`), a bad tag or an unbalanced block fails with `file:line:column`. The full list of values is the `CatalogContext` type in `@outstaff/core`. The stock catalog ships only the seven launch roles; the loader and renderer tests use a tiny `example` role from a fixture catalog in `@outstaff/core`.

## Toolsets

`toolsets/<name>.yaml` holds command permission rules for a family of tools, matching the image variants: `code` (language toolchains) and `infra` (read-only terraform, kubectl and helm verbs). Core loads them with `loadToolset()` and `toolsetToPack()` and merges the result into `buildPolicy({ packs })`. Teams add their own tools under `policies.commands` in `team.yaml`.
