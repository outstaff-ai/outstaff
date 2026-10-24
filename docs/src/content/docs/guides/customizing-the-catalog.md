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

You can also add roles the stock catalog does not have, in `.outstaff/catalog/roles/<role>/`. They merge with the stock roles and can `extends` them. Scaffolding with `ost role new` is tracked in [#105](https://github.com/outstaff-ai/outstaff/issues/105).
