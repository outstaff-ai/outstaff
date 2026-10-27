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

1. **Secrets present.** Every required key is a file in the scope's secrets folder (`--secrets-dir`, then `OUTSTAFF_SECRETS_DIR`, then `.outstaff/secrets/<handle|office>` next to the team file) or an environment variable, files first. A GitHub private key may be given as `..._PRIVATE_KEY` or `..._PRIVATE_KEY_FILE`.
2. **File modes.** A secret file readable by group or others fails; another mode that is not `0600` (for example `0400`) warns.
3. **Live checks per adapter**, listed below.

| Adapter              | Checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github`             | The App key signs a JWT and `/app` answers. The slug matches `..._SLUG` and the person's `identities.vcs`. The installation id exists and belongs to the account that owns the repositories. The office App covers every granted repository (a missing one fails). A person's own App covers exactly the repositories they can write (a missing one fails; an extra one warns, because the App can write there). A write grant needs `contents`, `pull_requests` and `issues` write permission and `actions` read (so `ost pr checks` can read the logs of failed CI jobs), and a role with the `vcs.workflows` capability (devops) also needs `workflows` write; a missing one fails and names it. Any permission beyond what the grants and the role need (for example `repository_hooks`, or `workflows` for a role that does not change CI) is a warning, as least-privilege advice. The office App is read-only: any write permission fails. |
| `slack`              | `auth.test` accepts the bot token. The bot user id matches `identities.chat` and `SLACK_BOT_USER_ID`. An app-level token (`xapp-`) is present for agents, which use Socket Mode. For the office, `auth.test` accepts `SLACK_OFFICE_BOT_TOKEN`, and it fails if that token belongs to an agent's app.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `itsaplan`           | An authenticated call works. The member behind the key matches `identities.tracker` and `ITSAPLAN_MEMBER_ID`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| office (people only) | When `OUTSTAFF_OFFICE_URL` is set, as the agent reads it: `GET /healthz` answers, then the agent protocol handshake succeeds with `OUTSTAFF_AGENT_TOKEN` and closes. An unreachable office and a rejected token are separate failures. The office serves health on its own port, so set `OUTSTAFF_OFFICE_HEALTH_URL` (for example `http://office:8081`) when it differs from the origin of the office URL. Without `OUTSTAFF_OFFICE_URL` this is a warning and is skipped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `claude-agent-sdk`   | One documented credential is present: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` or a cloud provider switch. No network call. For a person whose role declares `design.canvas` (the stock designer), while `policies.design.canvas` is on, a Design canvas check: `ok` with `CLAUDE_CODE_OAUTH_TOKEN`, a warning with an API key, a cloud provider or no credential, because [the Artifact tools need a Claude account login](/guides/design-canvas/).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

The office scope warns that doctor looks at the secrets and providers visible from where it runs and does not contact the running office; run `ost doctor --via-office` (below) to see what the office itself sees.

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

Run it from anywhere inside the repository. Without a handle, doctor reads each scope from its own folder under `.outstaff/secrets/`. `--secrets-dir` and `OUTSTAFF_SECRETS_DIR` name one folder and apply to every scope checked, so use them with a handle:

```sh
ost doctor sam --secrets-dir /run/secrets/sam
```

## The office runs the checks itself

The running office makes the checks it can see from its own container, so an expired key, a removed secret or a revoked App installation shows up before an agent fails on it:

- at start, once the office is running (it does not hold up readiness);
- every day at `office.doctor.daily_at` (`HH:MM`, default `06:00`) in the office container's time zone (its `TZ`, UTC unless set);
- on demand, with `ost doctor --via-office` or the office link's `health` request.

The office checks its own scope: every office secret is present (including each person's `OUTSTAFF_AGENT_TOKEN_<HANDLE>`; file modes are left to the platform that mounts the secrets), and each configured adapter's live checks as listed above, for example the office GitHub App's repositories and permissions and the Slack office token. `office.doctor.skip` lists ports (for example `[chat]`) whose live checks the office leaves out, for a provider it cannot or should not call; their secrets are still checked, and `ost doctor` still runs them.

Each agent checks what only its own container can tell when it starts, and reports the result to the office over the agent connection:

| Check             | Fails when                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tools install     | A tool declared for the person (toolsets, `tools:`) did not install; one check per tool, with mise's reason.                                                    |
| Services, devices | A granted HTTP service does not answer, adb does not run, or an adb device does not accept a connection (a wireless device only warns, since its port changes). |
| Home volume space | The volume of the agent's home is 90% full or more; from 80% it warns. The message gives used and total space; the fix is to free space or grow the volume.     |

The office stores every check with its status, message, fix, when it first had that status and when a run last reported it. A check keeps its status until a later run of the same scope (the office's own, or that agent's next start) reports otherwise, so a failing check stays failing until a run passes; a check a later run no longer reports is dropped. The office logs each run (`doctor: checks recorded`, with the counts) and each check that is not ok (`doctor: <check>`, at `warn`). It never posts the results to chat or the tracker.

Where the results show up:

- **`ost doctor --via-office`** asks the running office to run its checks now and prints every stored check, the office's and the agents', in the format above, with the time each status was first seen. It reaches the office's health port at `OUTSTAFF_OFFICE_HEALTH_URL` (for example `http://localhost:8081` through a port forward), else at the origin of `OUTSTAFF_OFFICE_URL`. With a handle or `office` it keeps that scope; `--json` prints the office's answer. It exits 1 when a check fails or the office does not answer.
- **The office's health** has a `doctor` component with the counts, for example `"doctor": { "ok": true, "detail": "14 ok, 1 warn, 1 fail" }`. It is always `ok`: a failing check is for a person to fix and never makes the platform restart the office.
- **The office link** answers the `health` method and sends a `health` notification when a check is added, removed or changes status (see the [office link reference](/reference/office-link/)).

Every option is in the [CLI reference](/reference/cli/#ost-doctor).
