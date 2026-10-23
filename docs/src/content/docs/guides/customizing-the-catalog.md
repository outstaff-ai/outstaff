---
title: Customizing the catalog
description: Eject stock roles, skills and documents, edit them, and keep them current with ost diff, ost upgrade and ost build.
---

The stock catalog (roles, skills, process documents, references, templates and toolsets) is baked into the Outstaff images, so a team that does not customize anything holds no catalog files. To change something, you eject it: copy it into your repository, edit it, and let Outstaff merge future catalog releases into your copy. See [decision 0005](/decisions/0005-catalog-baked-and-ejectable/) for the reasoning.

## Eject

```
ost eject developer              # a role: role.yaml, SKILL.md and any other files in the folder
ost eject references/git        # one document: process/, references/, templates/ or toolsets/
ost eject developer references/git
ost eject --all
```

Files are copied to the ejected catalog, `.outstaff/catalog/` unless `catalog.path` in `team.yaml` says otherwise, at the same path they have in the stock catalog. Ejected files win over stock files with the same path.

Eject also records where each file came from:

- `.outstaff/catalog/.ejected.json` maps each file to the catalog `version` and the `sha256` of the original.
- `.outstaff/catalog/.base/` keeps a copy of each original, so `ost diff` and `ost upgrade` never need an older release installed. Commit both with your changes.

`ost eject` refuses to overwrite a file that already exists and writes nothing in that case. Pass `--force` to overwrite and reset the recorded base.

## Edit and review

Edit the files like any other file in your repository. Placeholders such as `{{team.name}}` are checked strictly, so a typo fails the build instead of reaching an agent.

```
ost diff                    # every ejected file
ost diff roles/developer    # one file or folder
```

`ost diff` prints a unified diff of your copy against the recorded base. Use `ost render <handle>` to see the files an agent will get.

## Upgrade

Install the newer catalog (a new `outstaff` release, or the newer image), then run:

```
ost upgrade
ost upgrade --to 1.2.0   # fails unless 1.2.0 is the installed catalog
```

For each ejected file, `ost upgrade` merges three ways: the recorded base, the new stock file and your copy.

| Result             | Meaning                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unchanged`        | The stock file did not change.                                                                                                                          |
| `updated`          | You had not edited it, so it now matches the new stock file.                                                                                            |
| `merged`           | Both changed, and the changes combined cleanly.                                                                                                         |
| `conflict`         | Both changed the same lines. The file holds `<<<<<<< client`, `=======` and `>>>>>>> stock` markers; edit it and remove them. The command exits with 1. |
| `deleted-upstream` | The file no longer exists in the stock catalog. It is reported and kept; delete it yourself if you do not need it.                                      |
| `reverted`         | You deleted the ejected file, so it follows stock again and is no longer recorded.                                                                      |

Recorded bases move to the new version, and `catalog.version` in `team.yaml` is set to it. Review the result with `git diff` before committing.

## Build your image

A team with ejected files builds its own image `FROM` the Outstaff image:

```dockerfile
FROM ghcr.io/outstaff-ai/agent:1.2.0
COPY .outstaff /opt/outstaff/team/.outstaff
RUN ost build
```

`ost build` validates the team, loads the stock and ejected catalogs, rejects files that still contain conflict markers, and renders every person strictly. Any error stops the build with a non-zero exit code, and a summary is printed on success. Keep the image tag equal to `catalog.version`.

## Custom roles

You can add roles the stock catalog does not have. A custom role lives next to your ejected files in `.outstaff/catalog/roles/<role>/`, but it is not an ejected copy of anything: there is no stock original, so nothing is recorded in `.ejected.json`, `ost diff` has nothing to compare, and `ost upgrade` never touches it.

```
ost role new auditor
ost role new qa --from reviewer --title "QA Engineer"
ost role new data-engineer --profile code --toolset code
```

This writes `roles/<name>/role.yaml` and `roles/<name>/SKILL.md`.

- Without `--from`, both files come from a minimal template with `TODO` placeholders for the summary, the modes and the instructions.
- With `--from <stock-role>`, both files are copies of that stock role with the name and title replaced. The copy stops following stock; if you want future catalog changes merged into it, `ost eject` the role and edit it instead.
- `--title` sets the display title (the name in title case by default). `--profile` (`readonly`, `docs`, `code` or `infra`) and `--toolset` (`base`, `code` or `infra`) set the permission profile and tool bundle; they default to `docs` and `base`, or to the `--from` role's values.

The name must be a DNS-safe label: lowercase letters, digits and dashes, starting with a letter, at most 63 characters. A name that belongs to a stock role is refused, and the error points to `ost eject`. An existing custom role is only replaced when you pass `--force`.

Fill in the placeholders, then give a person the role in `team.yaml`:

```yaml
people:
  - handle: ines
    name: Ines Moreau
    role: auditor
```

`ost validate` accepts the role like any stock one, `ost render` and `ost build` render it, and the template context lists it in `roles[]` and `people.byRole`, so other roles' skills can mention it. A role can also list other roles in `extends` to include their skills.

### A role that needs extra tools

`role.yaml` picks one of the stock tool bundles, and permissions grant commands from those bundles. Tools the base images do not ship go into your own image, built `FROM` the Outstaff image:

```dockerfile
FROM ghcr.io/outstaff-ai/agent:1.2.0
RUN apt-get update && apt-get install -y --no-install-recommends shellcheck \
  && rm -rf /var/lib/apt/lists/*
COPY .outstaff /opt/outstaff/team/.outstaff
RUN ost build
```

Describe the tools in the role's `SKILL.md` so the agent knows to use them. Keep the image tag equal to `catalog.version`.
