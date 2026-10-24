---
title: Hire and remove people
description: Add a person to the team with ost hire, which generates what you leave out, and remove one with ost fire.
---

A person is an entry in `people` in the team file, credentials of their own, and a container. `ost hire` does the part that can be done from the command line, keeps the file's comments and formatting, and prints the rest as steps. `ost fire` is the reverse.

## Hire

```sh
ost hire developer
ost hire reviewer --name "Ines Varga" --pronouns she/her --yes
```

The argument is a role from the stock catalog or a [custom one](/guides/customizing-the-catalog/). Everything else is optional; what you leave out is generated:

| Value      | If not given                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name`   | A name from a small built-in list of neutral names whose handle is free.                                                                    |
| `--handle` | The first name, as a DNS label of at most 30 characters. A handle that is taken, or `office`, gets a numeric suffix (`sam-2`).              |
| Pronouns   | Asked for in a terminal, `they/them` otherwise.                                                                                             |
| `--model`  | Left out of the file, so the runtime adapter's default applies.                                                                             |
| `--repos`  | Write on the primary repository for code roles and on the infra repository for infra roles, read on everything else. Other roles read only. |
| `--avatar` | The handle as the seed. An `https` URL is stored as `avatar.url` instead.                                                                   |

In a terminal it asks about the name, handle, pronouns and repo grants (press Enter to keep the generated value), shows a summary and asks to confirm. Without a terminal it needs `--yes`; with `--json` and no `--yes` it prints the plan with `"written": false` and changes nothing.

## What it does

1. Checks that git would ignore the secrets, as [`ost setup`](/guides/setup/) does, before writing anything.
2. Adds the person to `people` in `team.yaml`. Comments, quoting and the other sections stay as they were.
3. Renders the avatar to `.outstaff/people/<handle>/avatar.svg` (or `.png`) when `integrations.avatars` is configured.
4. Does what `ost setup <handle>` does: writes `.outstaff/people/<handle>/.env.example` and prints the guide per adapter.
5. Prints the next steps and runs `ost validate`.

It creates nothing in GitHub, the chat workspace or the tracker.

## Then

1. Follow the setup guide to create the person's GitHub App, chat app and tracker member, and fill the identities in the team file: `identities.vcs`, `identities.chat` and `identities.tracker`. The office recognizes the agent's own activity only by an exact match.
2. Add the container. `ost hire` prints the pieces in the pattern of the examples:
   - [Docker Compose](/guides/compose/): a service, its home volume and its secrets, plus the office's copy of the person's token.
   - [Kubernetes](/guides/kubernetes/): a `people/<handle>/kustomization.yaml` and a line in the top `kustomization.yaml`.

   The secret names printed are those of the configured adapters (the acme example uses GitHub, Slack and Its a Plan). The authoritative list is the `.env.example` that `ost setup` wrote.

3. Run [`ost setup <handle> --derive`](/guides/setup/) and [`ost doctor <handle>`](/guides/doctor/) until nothing fails.
4. Start the container, and say hello to the new person in the team's chat channel once they are connected.

## Fire

```sh
ost fire sam
```

Removes the person from `people`, again keeping the file's formatting. It refuses an unknown handle and asks to confirm (`--yes` without a terminal). If `policies.usage.shared` lists the person, they are removed from the group, and a group left with one member is dropped. Any other place that still mentions the handle is listed and left alone.

Nothing outside the team file changes. It prints what to remove by hand: the person's GitHub App, chat app and tracker member, their secrets, the compose service or Kubernetes folder, and the work still assigned to them in the office. Stop the agent's container first.

Every option is in the [CLI reference](/reference/cli/#ost-hire).
