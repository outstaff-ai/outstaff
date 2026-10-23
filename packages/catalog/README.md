# @outstaff/catalog

The catalog of agent roles and skills that ship with Outstaff, as plain content that can be used as is or ejected and customized. Early development; nothing is released yet.

## Format

```
roles/<role>/role.yaml   name, title, summary, toolset (base|code|infra),
                         permissions (readonly|docs|code|infra), needs,
                         optional_needs, default_model, modes[{name, when}],
                         extends[], files {skill: SKILL.md}
roles/<role>/SKILL.md    the role's skill
process/*.md  references/*.md  templates/*.md
profiles/                reserved
```

The catalog version is the `version` of this package. Markdown files may use team values:

- `{{ team.name }}`, `{{ repos.primary.name }}`, `{{ links.issue }}`
- `{{#if path}}..{{else}}..{{/if}}`, `{{#unless path}}..{{/unless}}`, `{{#each path}}{{this.field}} {{@index}}{{/each}}`
- `\{{` prints a literal `{{`

Which values a file sees depends on its kind:

Every file gets the same context: `team`, `repos`, `people` (and `people.byRole`), `integrations`, `links` and `policies`. There is no `person`: a skill describes how a role works, so it reads the same for everyone in that role. Who the agent is (name, handle, role, team) is built from data by the runtime when the agent starts, not templated here. Using `{{ person.* }}` anywhere is an error.

Rendering is strict: an unknown path (also in `#if`), a bad tag or an unbalanced block fails with `file:line:column`. The full list of values is the `CatalogContext` type in `@outstaff/core`. `packages/catalog/roles/example` is a tiny example for tests, not a real role.
