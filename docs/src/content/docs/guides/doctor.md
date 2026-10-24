---
title: Check your setup
description: Verify secrets, GitHub Apps, Slack, the tracker and the model credential of the office and of each person with ost doctor.
---

`ost doctor` answers "will this actually work?" before you start a container. It reads the same secrets the containers read, calls each provider, and compares the answers with your team file. Every finding names the value to fix. It never prints a secret.

```sh
ost doctor                 # the office and every person
ost doctor sam             # one person
ost doctor office --json   # machine-readable
```

Run it after [`ost setup`](/guides/setup/), and again whenever you change a grant, an App or a token.

## What is checked

The team file is validated first, as `ost validate` does; doctor stops if it has errors. Then, for each scope:

1. **Secrets present.** Every required key is a file in the secrets directory (`--secrets-dir`, then `OUTSTAFF_SECRETS_DIR`, then `./secrets`) or an environment variable, files first. A GitHub private key may be given as `..._PRIVATE_KEY` or `..._PRIVATE_KEY_FILE`.
2. **File modes.** A secret file readable by group or others fails; another mode that is not `0600` (for example `0400`) warns.
3. **Live checks per adapter**, listed below.

| Adapter              | Checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github`             | The App key signs a JWT and `/app` answers. The slug matches `..._SLUG` and the person's `identities.vcs`. The installation id exists and belongs to the account that owns the repositories. The installation covers exactly the granted repositories (a missing one fails, an extra one warns). A write grant needs `contents`, `pull_requests` and `issues` write permission. The office App is read-only: any write permission fails.                                   |
| `slack`              | `auth.test` accepts the bot token. The bot user id matches `identities.chat` and `SLACK_BOT_USER_ID`. An app-level token (`xapp-`) is present for agents, which use Socket Mode. For the office, `auth.test` accepts `SLACK_OFFICE_BOT_TOKEN`, and it fails if that token belongs to an agent's app.                                                                                                                                                                       |
| `itsaplan`           | An authenticated call works. The member behind the key matches `identities.tracker` and `ITSAPLAN_MEMBER_ID`.                                                                                                                                                                                                                                                                                                                                                              |
| office (people only) | When `OUTSTAFF_OFFICE_URL` is set, as the agent reads it: `GET /healthz` answers, then the agent protocol handshake succeeds with `OUTSTAFF_AGENT_TOKEN` and closes. An unreachable office and a rejected token are separate failures. The office serves health on its own port, so set `OUTSTAFF_OFFICE_HEALTH_URL` (for example `http://office:8081`) when it differs from the origin of the office URL. Without `OUTSTAFF_OFFICE_URL` this is a warning and is skipped. |
| `claude-agent-sdk`   | One documented credential is present: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` or a cloud provider switch. No network call.                                                                                                                                                                                                                                                                                                                                          |

The office scope warns that doctor looks at the secrets and providers visible from where it runs and does not contact the running office; run `ost doctor office` inside the office container (secrets in `/run/secrets/outstaff`) to check what the office itself sees.

Adapters this build does not ship produce a warning, since nothing can be checked for them.

## Reading the result

```text
mira
  ok    GH_APP_ID present: Provided.
  fail  GitHub App: repositories: The installation does not cover acme-example/design-system.
        Fix: Add those repositories to the App's installation.
  warn  Slack identity: identities.chat is not set for mira, so the office cannot recognise its messages.
        Fix: Set identities.chat to U0MIRA in the team file.

18 ok, 1 warning, 1 failure
```

The exit code is 0 when nothing failed (warnings are allowed) and 1 otherwise, so doctor can gate a deploy. With `--json`, the output holds `ok`, a `summary` of counts and one entry per scope with its checks (`key`, `name`, `status`, `detail`, `fix`).

Without a handle, doctor reads one secrets directory for the office and for every person. People normally have separate secrets, so check each with its own `--secrets-dir`:

```sh
ost doctor sam --secrets-dir ./secrets-sam
ost doctor office --secrets-dir ./secrets-office
```

Every option is in the [CLI reference](/reference/cli/#ost-doctor).
