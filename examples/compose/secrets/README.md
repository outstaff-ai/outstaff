# Secret files

This folder holds one file per secret. Everything here except this README is ignored by git, so real values cannot be committed by accident. `compose.yaml` mounts each file at `/run/secrets/outstaff/<KEY>` in the container that needs it. Set `SECRETS_DIR` to keep the files somewhere else.

A file holds the bare value and nothing else; a trailing newline is trimmed. Make the files readable by the container user (uid 10001), for example `chmod 0444`, or `chown 10001 <file> && chmod 0400 <file>` as root. Compose bind-mounts them as they are on the host.

These are the files for the acme example team, whose adapters are github, itsaplan, slack and claude-agent-sdk. Each adapter declares its own secrets, so your list depends on your `integrations`. Run `ost setup office` and `ost setup <handle>` to get the exact keys for your team (each `.env.example` says where every value comes from). See [Secrets](https://docs.outstaff.work/guides/secrets/) for storing the files with 1Password or SOPS instead of typing them in.

## secrets/office/

The team-wide secrets. Drop or replace the rows of an adapter you do not use.

### github

| File                            | Used by        | What it is                                   |
| ------------------------------- | -------------- | -------------------------------------------- |
| `GH_OFFICE_APP_ID`              | office, agents | Id of the team's read-only office GitHub App |
| `GH_OFFICE_APP_INSTALLATION_ID` | office, agents | Its installation id on the team's account    |
| `GH_OFFICE_APP_PRIVATE_KEY`     | office, agents | Its private key (PEM text)                   |
| `GH_OFFICE_APP_SLUG`            | office, agents | Its URL slug                                 |

### itsaplan

| File               | Used by | What it is                                                      |
| ------------------ | ------- | --------------------------------------------------------------- |
| `ITSAPLAN_API_KEY` | office  | API key of the member account the office acts as in the tracker |

### slack

| File                     | Used by | What it is                                                              |
| ------------------------ | ------- | ----------------------------------------------------------------------- |
| `SLACK_OFFICE_BOT_TOKEN` | office  | Bot token of the Slack app the office uses (`xoxb-...`), not an agent's |

## secrets/<handle>/

One folder per person: `priya`, `tomas`, `mira`, `leo`, `sam`, `noor`, `ines`, `kofi`.

### Outstaff

| File                   | What it is                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `OUTSTAFF_AGENT_TOKEN` | A long random value you choose. The office gets the same file as `OUTSTAFF_AGENT_TOKEN_<HANDLE>`. |

Generate one with `openssl rand -hex 32 > secrets/priya/OUTSTAFF_AGENT_TOKEN`.

### claude-agent-sdk

| File                | What it is                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `ANTHROPIC_API_KEY` | The agent's Anthropic API key. To sign in another way, see the container contract and change the file. |

### github

| File                     | What it is                         |
| ------------------------ | ---------------------------------- |
| `GH_APP_ID`              | Id of this person's own GitHub App |
| `GH_APP_INSTALLATION_ID` | Its installation id                |
| `GH_APP_PRIVATE_KEY`     | Its private key (PEM text)         |
| `GH_APP_SLUG`            | Its URL slug                       |

### slack

| File              | What it is                                       |
| ----------------- | ------------------------------------------------ |
| `SLACK_APP_TOKEN` | This person's Slack app-level token (`xapp-...`) |
| `SLACK_BOT_TOKEN` | This person's Slack bot token (`xoxb-...`)       |

### itsaplan

| File               | What it is                                          |
| ------------------ | --------------------------------------------------- |
| `ITSAPLAN_API_KEY` | API key of this person's own tracker member account |

To change adapters, also edit the `secrets:` lists in `compose.yaml`.
