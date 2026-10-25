---
title: Set up credentials
description: Create the accounts and apps for a new person or for the office with ost setup, and let it fill in the values it can look up.
---

Every agent signs in to your tools with credentials of its own, and the office needs a few as well. Outstaff never stores them ([0008](/decisions/0008-hosting-and-secrets-out-of-scope/)); `ost setup` tells you what to create, writes a template of the keys, and looks up every value you would otherwise copy by hand. This page is the flow. The list of every key is in the [container contract](/reference/container-contract/#which-container-needs-which-secret).

## Before you start

- A [team file](/concepts/team-config/) with the integrations you use. `ost setup` reads the adapters from `integrations` and the repositories and grants from `repos` and `people`.
- A secrets directory that git ignores. By default it is `.outstaff/secrets/` next to the team file: one folder per scope, `.outstaff/secrets/<handle>/` for each person and `.outstaff/secrets/office/` for the office, with one file per key, named after the key. A container reads one such folder from `/run/secrets/outstaff` or `OUTSTAFF_SECRETS_DIR` ([secrets are files first](/reference/container-contract/#secrets)). Add this to `.gitignore`:

  ```text
  .outstaff/secrets/
  .outstaff/**/.env
  ```

Run `ost` commands from anywhere inside the repository: without `--team`, the team file is the first `.outstaff/team.yaml` or `team.yaml` found in the current directory or a parent, up to the git root. `ost setup` writes below the project root (the folder that holds `.outstaff/`); `--out` picks another one.

`ost setup` refuses to run until git ignores the `.env` file it names and the secrets directory it will use (if that is inside the repository), and prints the lines to add. `ost init` already adds both rules.

## A new person

Add the person to `people` in `team.yaml` with their repo grants (`ost hire` does this and runs the next step for you, see [Hire and remove people](/guides/hiring/)), then:

```sh
ost setup sam
```

This writes `.outstaff/people/sam/.env.example` and prints a guide per adapter. The template lists every key the configured adapters need for that person, each with what it is, where to get it, whether it is optional and whether it is derivable. It also shows where the secret files go. It never contains a real value.

Follow the guides in order:

1. **Slack.** Create the app from the printed manifest (Socket Mode, the scopes and events the adapter uses), create the app-level token and install the app. Keep `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN`.
2. **GitHub.** What this step asks for follows the person's repository grants. With no grants (a product manager or a designer who works in tickets, documents and chat), there is nothing to do: no GitHub keys are listed, [`ost doctor`](/guides/doctor/) skips GitHub, and the agent starts without a code host. With read grants only, the office App's keys are required and the person's own App is optional. With any write grant, create the person's GitHub App with the printed permissions, install it on exactly the repositories the person can write (reads come from the office App), generate a private key and keep the App id and key; agents also hold the read-only office App's keys, to clone repositories they may only read. If the person's role declares the `vcs.workflows` capability (the stock devops role does), the printed permissions also include **Workflows: read and write**. Without it GitHub rejects a push that touches `.github/workflows/` with "refusing to allow a GitHub App to create or update workflow". Mind the risk: a workflow can read the repository's Actions secrets when it runs, so give Workflows only to roles that change CI. Other roles keep it off. Granting it on the App is your decision; when the installation has it, the office adds it to that person's write token automatically.
3. **Tracker.** Agents are real members of the tracker, so people can assign work to them. See [Its a Plan](/adapters/tracker-itsaplan/) for what the adapter uses. The tracker is invite-only, so there is one human step, once per agent:
   - Pick the agent's address. Plus-addressing on a human's mailbox is the default: `alex+sam@acme.example` delivers to `alex@acme.example`. Or use a forwarding scheme on a domain your team owns, for example Cloudflare Email Routing: `sam@agents.acme.example` forwarded to a human. Set `email.pattern` in the team file to the scheme and the guide uses it. Outstaff does not run a mailbox.
   - Invite that address to the team and the project. The invite arrives in the human's inbox.
   - A human accepts it, signs in as the member and creates the API key. Keep it as `ITSAPLAN_API_KEY`.
4. **Claude.** Choose how the agent signs in: an API key, a cloud provider, or your own subscription token (within the provider's terms).

Put each value in a file named after its key in the secrets directory, for example `.outstaff/secrets/sam/SLACK_BOT_TOKEN`. Keep the environment-variable route (`.env`) for platforms that can only inject variables; anything in the environment is visible to the agent's shell.

### Let it fill in the rest

```sh
ost setup sam --derive
```

`--derive` reads what you provided (files in the secrets directory first, then the environment) and looks up the values that can be computed:

| Adapter    | Needs                           | Derives                                                                                                                                    |
| ---------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub     | `GH_APP_ID` and the private key | `GH_APP_SLUG`, `GH_APP_INSTALLATION_ID` (the installation on the team's repository owner), `GH_APP_BOT_EMAIL`; the same for the office App |
| Slack      | `SLACK_BOT_TOKEN`               | `SLACK_BOT_USER_ID` (from `auth.test`)                                                                                                     |
| Its a Plan | `ITSAPLAN_API_KEY`              | `ITSAPLAN_MEMBER_ID` (from `/me`)                                                                                                          |

Derived values are written only as files into the secrets directory (`.outstaff/secrets/sam/`; `--secrets-dir` and then `OUTSTAFF_SECRETS_DIR` override it with one folder holding that scope's files) with mode 0600, and only when the key is not there yet. The command prints key names and warnings, never a value, so its output is safe to paste into a support thread. A warning such as "not installed yet" tells you what to fix before running it again.

GitHub offers the private key as a download. If you set `GH_APP_SLUG` (the name in the App's URL) first, `--derive` finds the newest `<slug>.*.pem` in `~/Downloads`, asks before moving it into the secrets directory as `GH_APP_PRIVATE_KEY`, and deletes the download. Pass `--yes` to skip the question in scripts.

## The office

```sh
ost setup office
ost setup office --derive
```

The office has its own template at `.outstaff/office/.env.example`: the read-only GitHub App that covers every team repository, the tracker member the office acts as, and one `OUTSTAFF_AGENT_TOKEN_<HANDLE>` per person. Generate each token yourself (`openssl rand -hex 32`) and give the same value to that agent as `OUTSTAFF_AGENT_TOKEN`. Slack and the model credentials belong to agents and are not listed.

## Then

Run `ost validate`, then [`ost doctor`](/guides/doctor/) to check the secrets against GitHub, Slack and the tracker. Give each container its secrets by whatever means you host with ([container contract](/reference/container-contract/)), and start them. Every option of the command is in the [CLI reference](/reference/cli/#ost-setup).
